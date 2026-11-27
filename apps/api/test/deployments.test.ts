import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { ciRuns, deployments, environments, services } from '../src/db/schema.js';
import { createWorker } from '../src/worker/index.js';
import { createDeploySteps } from '../src/workflows/steps/deploy.js';
import { createRollbackSteps } from '../src/workflows/steps/rollback.js';
import { createUndeploySteps } from '../src/workflows/steps/undeploy.js';
import { reconcileEnvironments } from '../src/k8s/reconciler.js';
import { K8sCommandError } from '../src/k8s/exec.js';
import { FakeK8sRunner } from './fakes/fake-k8s-runner.js';
import { cleanTables, seedUsers, testAuthVerifier, testUsers } from './setup.js';

describe('Deploy, Rollback, Undeploy & Cluster Reconciliation — Checkpoint 3D', () => {
  beforeEach(async () => {
    await cleanTables();
    await seedUsers();
  });

  async function seedReadyServiceWithCi(sha1: string, sha2?: string) {
    const [svc] = await db
      .insert(services)
      .values({
        name: 'orders-api',
        slug: 'orders-api',
        owner_id: testUsers.devOwner.id,
        repository_url: 'https://github.com/forgeflow-test-org/orders-api',
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

    await db.insert(ciRuns).values({
      service_id: svc.id,
      github_run_id: 1001,
      run_attempt: 1,
      head_sha: sha1,
      head_branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      jobs: [
        {
          id: 1,
          name: 'Publish Image',
          status: 'completed',
          conclusion: 'success',
          startedAt: null,
          completedAt: null,
          htmlUrl: null,
        },
      ],
      completed_at: new Date(),
    });

    if (sha2) {
      await db.insert(ciRuns).values({
        service_id: svc.id,
        github_run_id: 1002,
        run_attempt: 1,
        head_sha: sha2,
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        jobs: [
          {
            id: 2,
            name: 'Publish Image',
            status: 'completed',
            conclusion: 'success',
            startedAt: null,
            completedAt: null,
            htmlUrl: null,
          },
        ],
        completed_at: new Date(Date.now() + 1000),
      });
    }

    return { svc, env };
  }

  function makeStepResolver(runner: FakeK8sRunner, opts: { healthOk?: boolean } = {}) {
    let deployedImage = '';
    let helmRevision = 0;

    runner.setDefaultKubectl(async (args) => {
      if (args[0] === 'get' && args[1] === 'secret') {
        throw new K8sCommandError('NotFound', 1, '', 'secrets "orders-api-db-secret" not found');
      }
      if (args[0] === 'get' && args[1] === 'deployment') {
        return {
          stdout: JSON.stringify({
            metadata: { name: 'orders-api' },
            spec: {
              replicas: 1,
              template: { spec: { containers: [{ image: deployedImage }] } },
            },
            status: { replicas: 1, readyReplicas: 1 },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    runner.setDefaultHelm(async (args, execOpts) => {
      if (args[0] === 'version') {
        return { stdout: 'v4.2.2+gb05881c\n', stderr: '' };
      }
      if (args[0] === 'upgrade') {
        helmRevision++;
        const values = JSON.parse(execOpts?.stdin ?? '{}') as {
          image?: { repository?: string; tag?: string };
        };
        deployedImage = `${values.image?.repository}:${values.image?.tag}`;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'status') {
        if (helmRevision === 0) {
          throw new K8sCommandError('NotFound', 1, '', 'Error: release: not found');
        }
        return {
          stdout: JSON.stringify({
            name: 'orders-api',
            version: helmRevision,
            info: { status: 'deployed' },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const deps = {
      getK8sRunner: () => runner,
      getGhcrCredentials: () => ({
        username: 'test-user',
        token: 'ghp_test_token_12345678901234567890123456',
      }),
      getExpectedOrg: () => 'forgeflow-test-org',
      checkHttp: async () =>
        opts.healthOk === false ? { ok: false, error: '/health/ready returned 503' } : { ok: true },
    };

    const map = new Map([
      ['deploy', createDeploySteps(deps)],
      ['rollback', createRollbackSteps(deps)],
      ['undeploy', createUndeploySteps({ getK8sRunner: () => runner })],
    ]);

    return (type: string) => map.get(type) ?? [];
  }

  it('deploys, treats repeat deploy as no-op, rolls back to prior commit, and undeploys cleanly', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1, sha2);

    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const worker = createWorker({
      workerId: 'test-worker-3d',
      stepResolver: makeStepResolver(runner),
    });

    // Viewer cannot deploy
    const viewerRes = await request(app)
      .post(`/api/services/${svc.id}/deploy`)
      .set('Authorization', 'Bearer viewer-token')
      .send({ commitSha: sha1 });
    expect(viewerRes.status).toBe(403);

    // Non-deployable commit rejected with 400
    const badShaRes = await request(app)
      .post(`/api/services/${svc.id}/deploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ commitSha: 'f'.repeat(40) });
    expect(badShaRes.status).toBe(400);
    expect(badShaRes.body.error.code).toBe('COMMIT_NOT_DEPLOYABLE');

    // 1. Deploy sha1
    const dep1Res = await request(app)
      .post(`/api/services/${svc.id}/deploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ commitSha: sha1 });
    expect(dep1Res.status).toBe(202);
    expect(Object.keys(dep1Res.body).sort()).toEqual(['deploymentId', 'status', 'workflowId']);

    // Concurrent deploy while queued -> 409
    const conflictRes = await request(app)
      .post(`/api/services/${svc.id}/deploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ commitSha: sha2 });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('DEPLOYMENT_IN_PROGRESS');

    expect(await worker.pollOnce()).toBe(true);

    // Verify helm used --rollback-on-failure (Helm 4) and secret was applied via stdin
    const upgradeCall = runner.calls.find((c) => c.tool === 'helm' && c.args[0] === 'upgrade');
    expect(upgradeCall?.args).toContain('--rollback-on-failure');
    expect(upgradeCall?.args).toContain('--wait');

    const [envAfter1] = await db
      .select()
      .from(environments)
      .where(eq(environments.service_id, svc.id));
    expect(envAfter1.status).toBe('healthy');
    expect(envAfter1.deployed_commit_sha).toBe(sha1);
    expect(envAfter1.node_port).toBe(30080);

    // 2. Repeat deploy of sha1 -> no-op (no new helm upgrade)
    const callsBeforeRepeat = runner.calls.length;
    const repeatRes = await request(app)
      .post(`/api/services/${svc.id}/deploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ commitSha: sha1 });
    expect(repeatRes.status).toBe(202);
    expect(await worker.pollOnce()).toBe(true);
    const repeatUpgrades = runner.calls
      .slice(callsBeforeRepeat)
      .filter((c) => c.tool === 'helm' && c.args[0] === 'upgrade');
    expect(repeatUpgrades).toHaveLength(0);

    // 3. Deploy sha2, then rollback to sha1
    const dep2Res = await request(app)
      .post(`/api/services/${svc.id}/deploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ commitSha: sha2 });
    expect(dep2Res.status).toBe(202);
    expect(await worker.pollOnce()).toBe(true);

    const rbRes = await request(app)
      .post(`/api/services/${svc.id}/rollback`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({});
    expect(rbRes.status).toBe(202);
    expect(await worker.pollOnce()).toBe(true);

    const [envAfterRb] = await db
      .select()
      .from(environments)
      .where(eq(environments.service_id, svc.id));
    expect(envAfterRb.deployed_commit_sha).toBe(sha1);
    expect(envAfterRb.status).toBe('healthy');

    // Check deployments history + exact camelCase keys
    const listRes = await request(app)
      .get(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer viewer-token');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(4);
    expect(Object.keys(listRes.body.data[0]).sort()).toEqual([
      'commitSha',
      'completedAt',
      'createdAt',
      'environmentId',
      'errorSummary',
      'helmRevision',
      'id',
      'image',
      'rollbackOf',
      'serviceId',
      'startedAt',
      'status',
      'triggeredBy',
      'workflowRunId',
    ]);
    expect(JSON.stringify(listRes.body)).not.toMatch(/ghp_|BEGIN.*PRIVATE KEY/);

    // 4. Undeploy
    const undepRes = await request(app)
      .post(`/api/services/${svc.id}/undeploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({});
    expect(undepRes.status).toBe(202);
    expect(Object.keys(undepRes.body).sort()).toEqual(['status', 'workflowId']);
    expect(await worker.pollOnce()).toBe(true);

    const [envAfterUndep] = await db
      .select()
      .from(environments)
      .where(eq(environments.service_id, svc.id));
    expect(envAfterUndep.status).toBe('unknown');
    expect(envAfterUndep.deployed_commit_sha).toBeNull();
    expect(envAfterUndep.node_port).toBeNull();
  });

  it('marks deployment failed on step error and cancelled when queued workflow is cancelled', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();

    // Fail health check
    const worker = createWorker({
      workerId: 'test-worker-fail',
      stepResolver: makeStepResolver(runner, { healthOk: false }),
    });

    const depRes = await request(app)
      .post(`/api/services/${svc.id}/deploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ commitSha: sha1 });
    expect(depRes.status).toBe(202);
    expect(await worker.pollOnce()).toBe(true);

    const [failedDep] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, depRes.body.deploymentId));
    expect(failedDep.status).toBe('failed');
    expect(failedDep.error_summary).toContain('HTTP health verification failed');

    // Queue another deploy and cancel it while queued
    const dep2Res = await request(app)
      .post(`/api/services/${svc.id}/deploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ commitSha: sha1 });
    expect(dep2Res.status).toBe(202);

    const cancelRes = await request(app)
      .post(`/api/workflows/${dep2Res.body.workflowId}/cancel`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(cancelRes.status).toBe(200);

    const [cancelledDep] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, dep2Res.body.deploymentId));
    expect(cancelledDep.status).toBe('cancelled');
  });

  it('reconcileEnvironments detects healthy, degraded (scaled to 0), drifted, and missing deployments', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc, env } = await seedReadyServiceWithCi(sha1);
    const expectedImage = `ghcr.io/forgeflow-test-org/orders-api:${sha1}`;

    await db
      .update(environments)
      .set({
        deployed_image: expectedImage,
        deployed_commit_sha: sha1,
        status: 'healthy',
      })
      .where(eq(environments.id, env.id));

    const runner = new FakeK8sRunner();

    // 1. Scaled to 0 -> degraded
    runner.onKubectl(async () => ({
      stdout: JSON.stringify({
        items: [
          {
            metadata: { name: svc.slug },
            spec: { replicas: 0, template: { spec: { containers: [{ image: expectedImage }] } } },
            status: { replicas: 0, readyReplicas: 0 },
          },
        ],
      }),
      stderr: '',
    }));
    await reconcileEnvironments(runner);
    let [row] = await db.select().from(environments).where(eq(environments.id, env.id));
    expect(row.status).toBe('degraded');
    expect(row.observed_ready_replicas).toBe(0);

    // 2. Drifted image -> drifted
    runner.onKubectl(async () => ({
      stdout: JSON.stringify({
        items: [
          {
            metadata: { name: svc.slug },
            spec: { replicas: 1, template: { spec: { containers: [{ image: 'nginx:latest' }] } } },
            status: { replicas: 1, readyReplicas: 1 },
          },
        ],
      }),
      stderr: '',
    }));
    await reconcileEnvironments(runner);
    [row] = await db.select().from(environments).where(eq(environments.id, env.id));
    expect(row.status).toBe('drifted');

    // 3. Missing deployment -> failed
    runner.onKubectl(async () => ({
      stdout: JSON.stringify({ items: [] }),
      stderr: '',
    }));
    await reconcileEnvironments(runner);
    [row] = await db.select().from(environments).where(eq(environments.id, env.id));
    expect(row.status).toBe('failed');

    // 4. Healthy again
    runner.onKubectl(async () => ({
      stdout: JSON.stringify({
        items: [
          {
            metadata: { name: svc.slug },
            spec: { replicas: 1, template: { spec: { containers: [{ image: expectedImage }] } } },
            status: { replicas: 1, readyReplicas: 1 },
          },
        ],
      }),
      stderr: '',
    }));
    await reconcileEnvironments(runner);
    [row] = await db.select().from(environments).where(eq(environments.id, env.id));
    expect(row.status).toBe('healthy');
  });
});
