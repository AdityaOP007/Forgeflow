import crypto from 'crypto';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import {
  ciRuns,
  deployments,
  environments,
  services,
  webhookDeliveries,
} from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { cleanTables, seedUsers, testAuthVerifier, testUsers } from './setup.js';
import { FakeGitHubClient } from './fakes/fake-github-client.js';
import { syncAllServicesCiRuns, syncServiceCiRuns } from '../src/modules/ci/service.js';

const WEBHOOK_SECRET = 'test-webhook-secret-3c-only';

function signPayload(body: string, secret = WEBHOOK_SECRET): string {
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

describe('CI Status Sync, Webhook Endpoint & 3C Data Model — Checkpoint 3C', () => {
  beforeEach(async () => {
    await cleanTables();
    await seedUsers();
  });

  async function createTestService(name = 'orders-api', repoName = 'orders-api') {
    const [svc] = await db
      .insert(services)
      .values({
        name,
        slug: name,
        description: 'Test service',
        owner_id: testUsers.devOwner.id,
        repository_url: `https://github.com/forgeflow-test-org/${repoName}`,
        provisioning_status: 'ready',
        template_version: '1.1.0',
      })
      .returning();

    const [env] = await db
      .insert(environments)
      .values({
        service_id: svc.id,
        name: 'development',
        cluster: 'kind-forgeflow',
        namespace: 'forgeflow-dev',
        status: 'unknown',
      })
      .returning();

    return { svc, env };
  }

  describe('Database Constraints (Migration 0002)', () => {
    it('enforces partial unique index on active deployments per environment and commit_sha check', async () => {
      const { svc, env } = await createTestService();
      const sha1 = 'a'.repeat(40);
      const sha2 = 'b'.repeat(40);

      // Invalid commit_sha rejected by CHECK constraint
      await expect(
        db.insert(deployments).values({
          service_id: svc.id,
          environment_id: env.id,
          commit_sha: 'not-a-sha',
          image: `ghcr.io/forgeflow-test-org/orders-api:${sha1}`,
          status: 'queued',
        })
      ).rejects.toThrow();

      // First queued deployment succeeds
      const [dep1] = await db
        .insert(deployments)
        .values({
          service_id: svc.id,
          environment_id: env.id,
          commit_sha: sha1,
          image: `ghcr.io/forgeflow-test-org/orders-api:${sha1}`,
          status: 'queued',
        })
        .returning();

      // Second active (in_progress) deployment on same environment fails partial unique index
      await expect(
        db.insert(deployments).values({
          service_id: svc.id,
          environment_id: env.id,
          commit_sha: sha2,
          image: `ghcr.io/forgeflow-test-org/orders-api:${sha2}`,
          status: 'in_progress',
        })
      ).rejects.toThrow();

      // Once first deployment finishes, another queued deployment is allowed
      await db.update(deployments).set({ status: 'succeeded' }).where(eq(deployments.id, dep1.id));

      const [dep2] = await db
        .insert(deployments)
        .values({
          service_id: svc.id,
          environment_id: env.id,
          commit_sha: sha2,
          image: `ghcr.io/forgeflow-test-org/orders-api:${sha2}`,
          status: 'queued',
        })
        .returning();

      expect(dep2.status).toBe('queued');
    });

    it('enforces environments.node_port range check (30080-30089)', async () => {
      const { svc } = await createTestService();

      await expect(
        db.insert(environments).values({
          service_id: svc.id,
          name: 'staging',
          node_port: 30090,
          status: 'unknown',
        })
      ).rejects.toThrow();

      const [staging] = await db
        .insert(environments)
        .values({
          service_id: svc.id,
          name: 'staging',
          node_port: 30081,
          status: 'unknown',
        })
        .returning();

      expect(staging.node_port).toBe(30081);
    });
  });

  describe('CI Status Sync & Endpoints', () => {
    it('syncs workflow runs and jobs from FakeGitHubClient and skips completed runs on repeat sync', async () => {
      const { svc } = await createTestService();
      const fake = new FakeGitHubClient({ org: 'forgeflow-test-org' });
      await fake.createRepository({ name: 'orders-api' });

      const sha = 'c'.repeat(40);
      fake.setWorkflowRuns('orders-api', [
        {
          id: 5001,
          runAttempt: 1,
          headSha: sha,
          headBranch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/5001',
          runStartedAt: '2026-11-27T08:00:00Z',
          updatedAt: '2026-11-27T08:04:00Z',
        },
      ]);
      fake.setWorkflowJobs('orders-api', 5001, [
        {
          id: 1,
          name: 'Test',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-11-27T08:00:10Z',
          completedAt: '2026-11-27T08:01:00Z',
          htmlUrl: null,
        },
        {
          id: 2,
          name: 'Publish Image',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-11-27T08:01:05Z',
          completedAt: '2026-11-27T08:03:45Z',
          htmlUrl: null,
        },
      ]);

      const first = await syncServiceCiRuns(svc.id, fake, 'forgeflow-test-org');
      expect(first.synced).toBe(1);
      expect(first.runs).toHaveLength(1);
      expect(first.runs[0].publishSucceeded).toBe(true);
      expect(first.runs[0].jobs).toHaveLength(2);

      // Second sync skips already-completed run with jobs
      const second = await syncServiceCiRuns(svc.id, fake, 'forgeflow-test-org');
      expect(second.synced).toBe(0);
    });

    it('GET /api/services/:id/ci-runs and POST /api/services/:id/ci-runs/sync work with RBAC', async () => {
      const { svc } = await createTestService();
      const fake = new FakeGitHubClient({ org: 'forgeflow-test-org' });
      await fake.createRepository({ name: 'orders-api' });

      fake.setWorkflowRuns('orders-api', [
        {
          id: 7001,
          runAttempt: 1,
          headSha: 'd'.repeat(40),
          headBranch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/7001',
          runStartedAt: '2026-11-27T09:00:00Z',
          updatedAt: '2026-11-27T09:02:00Z',
        },
      ]);
      fake.setWorkflowJobs('orders-api', 7001, [
        {
          id: 11,
          name: 'Publish Image',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-11-27T09:00:30Z',
          completedAt: '2026-11-27T09:01:50Z',
          htmlUrl: null,
        },
      ]);

      const app = createApp({
        auth: testAuthVerifier,
        services: {
          createGitHubClient: () => ({ client: fake, org: 'forgeflow-test-org' }),
        },
      });

      // Viewer cannot trigger sync
      const viewerSync = await request(app)
        .post(`/api/services/${svc.id}/ci-runs/sync`)
        .set('Authorization', 'Bearer viewer-token');
      expect(viewerSync.status).toBe(403);

      // Developer can sync
      const devSync = await request(app)
        .post(`/api/services/${svc.id}/ci-runs/sync`)
        .set('Authorization', 'Bearer dev-owner-token');
      expect(devSync.status).toBe(200);
      expect(devSync.body.synced).toBe(1);
      expect(devSync.body.data).toHaveLength(1);
      expect(devSync.body.data[0].publishSucceeded).toBe(true);

      // Viewer can read synced CI runs
      const listRes = await request(app)
        .get(`/api/services/${svc.id}/ci-runs`)
        .set('Authorization', 'Bearer viewer-token');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].githubRunId).toBe(7001);
    });

    it('POST /api/services/:id/ci-runs/sync returns 503 when GitHub is not configured', async () => {
      const { svc } = await createTestService();
      const app = createApp({
        auth: testAuthVerifier,
        services: { createGitHubClient: () => null },
      });

      const res = await request(app)
        .post(`/api/services/${svc.id}/ci-runs/sync`)
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('GITHUB_NOT_CONFIGURED');
    });

    it('syncAllServicesCiRuns skips provisioning services and continues on per-service errors', async () => {
      const { svc: readySvc } = await createTestService('ready-svc', 'ready-svc');
      await db.insert(services).values({
        name: 'prov-svc',
        slug: 'prov-svc',
        owner_id: testUsers.devOwner.id,
        repository_url: 'https://github.com/forgeflow-test-org/prov-svc',
        provisioning_status: 'provisioning',
      });

      const fake = new FakeGitHubClient({ org: 'forgeflow-test-org' });
      await fake.createRepository({ name: 'ready-svc' });
      fake.setWorkflowRuns('ready-svc', [
        {
          id: 8001,
          runAttempt: 1,
          headSha: 'e'.repeat(40),
          headBranch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/forgeflow-test-org/ready-svc/actions/runs/8001',
          runStartedAt: '2026-11-27T10:00:00Z',
          updatedAt: '2026-11-27T10:02:00Z',
        },
      ]);

      const summary = await syncAllServicesCiRuns(fake, 'forgeflow-test-org');
      expect(summary.servicesChecked).toBe(1);
      expect(summary.runsSynced).toBe(1);
      expect(summary.errors).toBe(0);

      const stored = await db.select().from(ciRuns).where(eq(ciRuns.service_id, readySvc.id));
      expect(stored).toHaveLength(1);
    });
  });

  describe('GitHub Webhook Endpoint (/api/webhooks/github)', () => {
    it('returns 503 when webhook secret is not configured and 401 on invalid signature', async () => {
      const appUnconfigured = createApp({
        auth: testAuthVerifier,
        webhooks: { getWebhookSecret: () => undefined },
      });
      const unconfRes = await request(appUnconfigured)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ zen: 'test' }));
      expect(unconfRes.status).toBe(503);
      expect(unconfRes.body.error.code).toBe('WEBHOOK_NOT_CONFIGURED');

      const app = createApp({
        auth: testAuthVerifier,
        webhooks: { getWebhookSecret: () => WEBHOOK_SECRET },
      });
      const badSigRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .set('X-GitHub-Delivery', 'deliv-bad-1')
        .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
        .send(JSON.stringify({ zen: 'test' }));
      expect(badSigRes.status).toBe(401);
      expect(badSigRes.body.error.code).toBe('INVALID_SIGNATURE');
    });

    it('processes workflow_run and workflow_job events and deduplicates replayed deliveries', async () => {
      const { svc } = await createTestService('billing-api', 'billing-api');
      const app = createApp({
        auth: testAuthVerifier,
        webhooks: { getWebhookSecret: () => WEBHOOK_SECRET },
      });

      const sha = 'f'.repeat(40);
      const runPayload = JSON.stringify({
        action: 'completed',
        repository: {
          full_name: 'forgeflow-test-org/billing-api',
          html_url: 'https://github.com/forgeflow-test-org/billing-api',
        },
        workflow_run: {
          id: 9901,
          run_attempt: 1,
          head_sha: sha,
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/forgeflow-test-org/billing-api/actions/runs/9901',
          run_started_at: '2026-11-27T11:00:00Z',
          updated_at: '2026-11-27T11:03:00Z',
        },
      });

      const runRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'deliv-run-1')
        .set('X-Hub-Signature-256', signPayload(runPayload))
        .send(runPayload);
      expect(runRes.status).toBe(200);
      expect(runRes.body).toMatchObject({ ok: true, serviceId: svc.id, githubRunId: 9901 });

      // Replay same delivery ID -> duplicate: true
      const replayRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'deliv-run-1')
        .set('X-Hub-Signature-256', signPayload(runPayload))
        .send(runPayload);
      expect(replayRes.status).toBe(200);
      expect(replayRes.body).toEqual({ ok: true, duplicate: true });

      // workflow_job merges Publish Image job into the ci_runs row
      const jobPayload = JSON.stringify({
        action: 'completed',
        repository: {
          full_name: 'forgeflow-test-org/billing-api',
          html_url: 'https://github.com/forgeflow-test-org/billing-api',
        },
        workflow_job: {
          id: 44,
          run_id: 9901,
          run_attempt: 1,
          head_sha: sha,
          name: 'Publish Image',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-11-27T11:01:00Z',
          completed_at: '2026-11-27T11:02:50Z',
          html_url: 'https://github.com/forgeflow-test-org/billing-api/actions/runs/9901/job/44',
        },
      });

      const jobRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'workflow_job')
        .set('X-GitHub-Delivery', 'deliv-job-1')
        .set('X-Hub-Signature-256', signPayload(jobPayload))
        .send(jobPayload);
      expect(jobRes.status).toBe(200);

      // Verify GET /api/services/:id/ci-runs shows publishSucceeded = true
      const ciRes = await request(app)
        .get(`/api/services/${svc.id}/ci-runs`)
        .set('Authorization', 'Bearer viewer-token');
      expect(ciRes.status).toBe(200);
      expect(ciRes.body.data).toHaveLength(1);
      expect(ciRes.body.data[0].publishSucceeded).toBe(true);
      expect(ciRes.body.data[0].jobs).toHaveLength(1);

      // Unknown repository -> ignored
      const unknownPayload = JSON.stringify({
        repository: {
          full_name: 'other-org/unknown-repo',
          html_url: 'https://github.com/other-org/unknown-repo',
        },
        workflow_run: {
          id: 1,
          head_sha: sha,
          status: 'completed',
        },
      });
      const unknownRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'deliv-unknown-1')
        .set('X-Hub-Signature-256', signPayload(unknownPayload))
        .send(unknownPayload);
      expect(unknownRes.status).toBe(200);
      expect(unknownRes.body).toEqual({ ok: true, ignored: true });

      const deliveries = await db.select().from(webhookDeliveries);
      expect(deliveries).toHaveLength(3);
    });
  });
});
