import crypto from 'crypto';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import type { DeploymentStatus } from '@forgeflow/shared-types';
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
import { GitHubError } from '../src/github/types.js';
import {
  normalizeRun,
  syncAllServicesCiRuns,
  syncServiceCiRuns,
} from '../src/modules/ci/service.js';
import {
  DEPLOYMENT_TRANSITIONS,
  InvalidDeploymentTransitionError,
  assertDeploymentTransition,
  isLegalDeploymentTransition,
  transitionDeployment,
} from '../src/deployments/state-machine.js';

const WEBHOOK_SECRET = 'test-webhook-secret-3c-only';

function signPayload(body: string, secret = WEBHOOK_SECRET): string {
  const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

function collectPreAuthRoutes(app: ReturnType<typeof createApp>): string[] {
  const routes: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack: any[] = app._router?.stack ?? [];

  function walk(layers: typeof stack, prefix: string): void {
    for (const layer of layers) {
      if (layer.route?.path) {
        const methods = Object.keys(layer.route.methods ?? {})
          .filter((m) => layer.route.methods[m])
          .map((m) => m.toUpperCase());
        for (const m of methods) {
          routes.push(`${m} ${prefix}${layer.route.path}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Skip /api router which has the auth middleware
        const regexpSrc = String(layer.regexp?.source ?? '');
        if (regexpSrc.includes('\\/api\\/?(?=\\/|$)')) {
          continue;
        }
        const subPrefix = regexpSrc.includes('\\/api\\/webhooks') ? '/api/webhooks' : prefix;
        walk(layer.handle.stack, subPrefix);
      }
    }
  }

  walk(stack, '');
  return routes.sort();
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

  describe('Deployment State Machine', () => {
    it('enforces all legal transitions and rejects terminal/invalid transitions', () => {
      const allStatuses: DeploymentStatus[] = [
        'queued',
        'in_progress',
        'succeeded',
        'failed',
        'cancelled',
        'rolled_back',
      ];

      for (const from of allStatuses) {
        for (const to of allStatuses) {
          const expected = DEPLOYMENT_TRANSITIONS[from].includes(to);
          expect(isLegalDeploymentTransition(from, to)).toBe(expected);
          if (!expected) {
            expect(() => assertDeploymentTransition(from, to)).toThrow(
              InvalidDeploymentTransitionError
            );
          } else {
            expect(() => assertDeploymentTransition(from, to)).not.toThrow();
          }
        }
      }
    });

    it('transitionDeployment performs compare-and-set updates in DB and rejects terminal transitions', async () => {
      const { svc, env } = await createTestService();
      const sha = 'a'.repeat(40);
      const [dep] = await db
        .insert(deployments)
        .values({
          service_id: svc.id,
          environment_id: env.id,
          commit_sha: sha,
          image: `ghcr.io/forgeflow-test-org/orders-api:${sha}`,
          status: 'queued',
        })
        .returning();

      const inProgress = await transitionDeployment(db, dep.id, 'queued', 'in_progress', {
        started_at: new Date(),
      });
      expect(inProgress.status).toBe('in_progress');

      const succeeded = await transitionDeployment(db, dep.id, 'in_progress', 'succeeded', {
        completed_at: new Date(),
        helm_revision: 1,
      });
      expect(succeeded.status).toBe('succeeded');

      const rolledBack = await transitionDeployment(db, dep.id, 'succeeded', 'rolled_back');
      expect(rolledBack.status).toBe('rolled_back');

      await expect(transitionDeployment(db, dep.id, 'rolled_back', 'queued')).rejects.toThrow(
        InvalidDeploymentTransitionError
      );
    });
  });

  describe('normalizeRun & CI Status Sync & Deployable Commits', () => {
    it('normalizeRun computes publishSucceeded, completedAt, and lowercases headSha', () => {
      const shaUpper = 'A'.repeat(40);
      const normalized = normalizeRun(
        {
          id: 101,
          runAttempt: 2,
          headSha: shaUpper,
          headBranch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/org/repo/actions/runs/101',
          runStartedAt: '2026-11-27T08:00:00Z',
          updatedAt: '2026-11-27T08:03:00Z',
        },
        [
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
            startedAt: '2026-11-27T08:01:10Z',
            completedAt: '2026-11-27T08:04:00Z',
            htmlUrl: null,
          },
        ]
      );

      expect(normalized.headSha).toBe('a'.repeat(40));
      expect(normalized.publishSucceeded).toBe(true);
      expect(normalized.completedAt?.toISOString()).toBe('2026-11-27T08:04:00.000Z');
      expect(normalized.runAttempt).toBe(2);
    });

    it('syncs latest 10 default-branch runs and skips completed runs on repeat sync', async () => {
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
        {
          id: 5002,
          runAttempt: 1,
          headSha: 'd'.repeat(40),
          headBranch: 'feature/pr-only',
          event: 'pull_request',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/5002',
          runStartedAt: '2026-11-27T08:05:00Z',
          updatedAt: '2026-11-27T08:06:00Z',
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
      expect(first.runs[0].headBranch).toBe('main');
      expect(first.runs[0].publishSucceeded).toBe(true);

      // Second sync skips already-completed run with jobs
      const callsBefore = fake.callCount;
      const second = await syncServiceCiRuns(svc.id, fake, 'forgeflow-test-org');
      expect(second.synced).toBe(0);
      expect(fake.callCount).toBe(callsBefore + 1); // only listWorkflowRuns, no listWorkflowJobs
    });

    it('GET ci-runs, POST ci-runs/sync, and GET deployable-commits have exact camelCase keys and no secrets', async () => {
      const { svc } = await createTestService();
      const fake = new FakeGitHubClient({ org: 'forgeflow-test-org' });
      await fake.createRepository({ name: 'orders-api' });

      const shaDeployable = 'd'.repeat(40);
      const shaNoPublish = 'e'.repeat(40);

      fake.setWorkflowRuns('orders-api', [
        {
          id: 7001,
          runAttempt: 1,
          headSha: shaDeployable,
          headBranch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/7001',
          runStartedAt: '2026-11-27T09:00:00Z',
          updatedAt: '2026-11-27T09:02:00Z',
        },
        {
          id: 7002,
          runAttempt: 1,
          headSha: shaNoPublish,
          headBranch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/7002',
          runStartedAt: '2026-11-27T08:00:00Z',
          updatedAt: '2026-11-27T08:02:00Z',
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
      fake.setWorkflowJobs('orders-api', 7002, [
        {
          id: 12,
          name: 'Test',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-11-27T08:00:30Z',
          completedAt: '2026-11-27T08:01:50Z',
          htmlUrl: null,
        },
      ]);

      const app = createApp({
        auth: testAuthVerifier,
        services: {
          createGitHubClient: () => ({ client: fake, org: 'forgeflow-test-org' }),
        },
      });

      const viewerSync = await request(app)
        .post(`/api/services/${svc.id}/ci-runs/sync`)
        .set('Authorization', 'Bearer viewer-token');
      expect(viewerSync.status).toBe(403);

      const devSync = await request(app)
        .post(`/api/services/${svc.id}/ci-runs/sync`)
        .set('Authorization', 'Bearer dev-owner-token');
      expect(devSync.status).toBe(200);
      expect(Object.keys(devSync.body).sort()).toEqual(['data', 'synced']);
      expect(Object.keys(devSync.body.data[0]).sort()).toEqual([
        'completedAt',
        'conclusion',
        'createdAt',
        'event',
        'githubRunId',
        'headBranch',
        'headSha',
        'htmlUrl',
        'id',
        'jobs',
        'publishSucceeded',
        'runAttempt',
        'runStartedAt',
        'serviceId',
        'status',
        'updatedAt',
      ]);
      expect(JSON.stringify(devSync.body)).not.toMatch(/BEGIN.*PRIVATE KEY|ghs_|ghp_|github_pat_/);

      const listRes = await request(app)
        .get(`/api/services/${svc.id}/ci-runs`)
        .set('Authorization', 'Bearer viewer-token');
      expect(listRes.status).toBe(200);
      expect(Object.keys(listRes.body).sort()).toEqual(['data']);
      expect(listRes.body.data).toHaveLength(2);
      expect(JSON.stringify(listRes.body)).not.toMatch(/BEGIN.*PRIVATE KEY|ghs_|ghp_|github_pat_/);

      const deployableRes = await request(app)
        .get(`/api/services/${svc.id}/deployable-commits`)
        .set('Authorization', 'Bearer viewer-token');
      expect(deployableRes.status).toBe(200);
      expect(Object.keys(deployableRes.body).sort()).toEqual(['data']);
      expect(deployableRes.body.data).toHaveLength(1);
      expect(Object.keys(deployableRes.body.data[0]).sort()).toEqual([
        'ciRunId',
        'commitSha',
        'completedAt',
        'htmlUrl',
        'shortSha',
      ]);
      expect(deployableRes.body.data[0]).toMatchObject({
        commitSha: shaDeployable,
        shortSha: shaDeployable.slice(0, 7),
      });
      expect(JSON.stringify(deployableRes.body)).not.toMatch(
        /BEGIN.*PRIVATE KEY|ghs_|ghp_|github_pat_/
      );
    });

    it('syncAllServicesCiRuns isolates errors and backs off on RATE_LIMITED', async () => {
      await createTestService('svc-a', 'svc-a');
      await createTestService('svc-b', 'svc-b');

      const fake = new FakeGitHubClient({ org: 'forgeflow-test-org' });
      await fake.createRepository({ name: 'svc-a' });
      await fake.createRepository({ name: 'svc-b' });

      // Simulate RATE_LIMITED on first call
      fake.setFailAfterNCalls(0, new GitHubError('RATE_LIMITED', 'Rate limit exceeded', 429));
      const res = await syncAllServicesCiRuns(fake, 'forgeflow-test-org');
      expect(res.rateLimited).toBe(true);
      expect(res.servicesChecked).toBe(1);
      expect(res.errors).toBe(1);
    });
  });

  describe('GitHub Webhook Endpoint (/api/webhooks/github)', () => {
    it('mounts only health routes and POST /api/webhooks/github before auth middleware', () => {
      const app = createApp({ auth: testAuthVerifier });
      const preAuthRoutes = collectPreAuthRoutes(app);
      expect(preAuthRoutes).toEqual([
        'GET /health',
        'GET /health/ready',
        'POST /api/webhooks/github',
      ]);
    });

    it('returns 503 when not configured, 415 on non-JSON, 413 above 256kb, and omits CORS headers', async () => {
      const appUnconfigured = createApp({
        auth: testAuthVerifier,
        webhooks: { getWebhookSecret: () => undefined },
      });
      const unconfRes = await request(appUnconfigured)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ zen: 'test' }));
      expect(unconfRes.status).toBe(503);
      expect(unconfRes.headers['access-control-allow-origin']).toBeUndefined();

      const app = createApp({
        auth: testAuthVerifier,
        webhooks: { getWebhookSecret: () => WEBHOOK_SECRET },
      });

      // Non-JSON -> 415
      const nonJsonRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'text/plain')
        .send('hello');
      expect(nonJsonRes.status).toBe(415);

      // Oversized (> 256kb) -> 413
      const bigBody = JSON.stringify({ data: 'x'.repeat(260 * 1024) });
      const oversizedRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .set('X-GitHub-Delivery', 'deliv-big')
        .set('X-Hub-Signature-256', signPayload(bigBody))
        .send(bigBody);
      expect(oversizedRes.status).toBe(413);
    });

    it('rejects missing, wrong, and tampered signatures with 401 and writes zero DB rows', async () => {
      const app = createApp({
        auth: testAuthVerifier,
        webhooks: { getWebhookSecret: () => WEBHOOK_SECRET },
      });

      const body = JSON.stringify({ zen: 'keep it simple' });

      const missingSig = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .set('X-GitHub-Delivery', 'deliv-missing')
        .send(body);
      expect(missingSig.status).toBe(401);

      const wrongSig = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .set('X-GitHub-Delivery', 'deliv-wrong')
        .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
        .send(body);
      expect(wrongSig.status).toBe(401);

      const tamperedSig = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .set('X-GitHub-Delivery', 'deliv-tampered')
        .set('X-Hub-Signature-256', signPayload(body))
        .send(JSON.stringify({ zen: 'tampered!' }));
      expect(tamperedSig.status).toBe(401);

      expect(await db.select().from(webhookDeliveries)).toHaveLength(0);
      expect(await db.select().from(ciRuns)).toHaveLength(0);
    });

    it('processes workflow_run, workflow_job, replay, out-of-order stale update, and unknown repo', async () => {
      const { svc } = await createTestService('billing-api', 'billing-api');
      const app = createApp({
        auth: testAuthVerifier,
        webhooks: { getWebhookSecret: () => WEBHOOK_SECRET },
      });

      const sha = 'f'.repeat(40);
      const newerRunPayload = JSON.stringify({
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
        .set('X-Hub-Signature-256', signPayload(newerRunPayload))
        .send(newerRunPayload);
      expect(runRes.status).toBe(200);
      expect(runRes.body).toMatchObject({ ok: true, serviceId: svc.id, githubRunId: 9901 });

      // Replay same delivery ID -> duplicate: true, nothing new written
      const replayRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'deliv-run-1')
        .set('X-Hub-Signature-256', signPayload(newerRunPayload))
        .send(newerRunPayload);
      expect(replayRes.status).toBe(200);
      expect(replayRes.body).toEqual({ ok: true, duplicate: true });

      // Out-of-order older updated_at event must NOT overwrite newer completed state
      const olderRunPayload = JSON.stringify({
        action: 'in_progress',
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
          status: 'in_progress',
          conclusion: null,
          updated_at: '2026-11-27T11:01:00Z',
        },
      });
      const staleRes = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'workflow_run')
        .set('X-GitHub-Delivery', 'deliv-run-stale')
        .set('X-Hub-Signature-256', signPayload(olderRunPayload))
        .send(olderRunPayload);
      expect(staleRes.status).toBe(200);
      expect(staleRes.body).toEqual({ ok: true, stale: true });

      const [storedAfterStale] = await db
        .select()
        .from(ciRuns)
        .where(eq(ciRuns.service_id, svc.id));
      expect(storedAfterStale.status).toBe('completed');
      expect(storedAfterStale.conclusion).toBe('success');

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
      expect(deliveries).toHaveLength(4);
    });
  });
});
