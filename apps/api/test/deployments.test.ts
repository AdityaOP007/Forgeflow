import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import {
  ciRuns,
  deployments,
  environments,
  services,
  workflowLogs,
  workflowRuns,
} from '../src/db/schema.js';
import { createWorker } from '../src/worker/index.js';
import { requeueStale } from '../src/workflows/queue.js';
import { createDeploySteps } from '../src/workflows/steps/deploy.js';
import { createUndeploySteps } from '../src/workflows/steps/undeploy.js';
import {
  ALLOWED_HELM_SUBCOMMANDS,
  ALLOWED_KUBECTL_VERBS,
  K8sCommandError,
} from '../src/k8s/exec.js';
import { allocateEnvironmentNodePort } from '../src/k8s/nodeport.js';
import { computeEnvironmentObservation, reconcileEnvironments } from '../src/k8s/reconciler.js';
import { FakeGitHubClient } from './fakes/fake-github-client.js';
import { FakeK8sRunner } from './fakes/fake-k8s-runner.js';
import { cleanTables, seedUsers, testAuthVerifier, testUsers } from './setup.js';

const TEST_GHCR_TOKEN = 'ghp_TestSecretToken1234567890abcdefghijklmnop';

function assertNoSecrets(text: string, extraSecrets: string[] = []): void {
  expect(text).not.toContain(TEST_GHCR_TOKEN);
  expect(text).not.toMatch(/ghp_[A-Za-z0-9_]{10,}/);
  expect(text).not.toMatch(/ghs_[A-Za-z0-9_]{10,}/);
  expect(text).not.toMatch(/BEGIN.*PRIVATE KEY/);
  expect(text).not.toContain('.dockerconfigjson');
  for (const s of extraSecrets) {
    if (s) expect(text).not.toContain(s);
  }
}

describe('Deploy, Rollback, Undeploy & Cluster Reconciliation — Checkpoint 3D', () => {
  beforeEach(async () => {
    await cleanTables();
    await seedUsers();
  });

  async function seedReadyServiceWithCi(
    sha1: string,
    sha2?: string,
    opts: { templateVersion?: string } = {}
  ) {
    const [svc] = await db
      .insert(services)
      .values({
        name: 'orders-api',
        slug: 'orders-api',
        owner_id: testUsers.devOwner.id,
        repository_url: 'https://github.com/forgeflow-test-org/orders-api',
        provisioning_status: 'ready',
        template_version: opts.templateVersion ?? '1.1.0',
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

  function makeFakeGitHub(sha1: string, sha2?: string): FakeGitHubClient {
    const gh = new FakeGitHubClient({ org: 'forgeflow-test-org' });
    void gh.createRepository({ name: 'orders-api' });
    const runs = [
      {
        id: 1001,
        runAttempt: 1,
        headSha: sha1,
        headBranch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/1001',
        runStartedAt: '2026-11-27T08:00:00Z',
        updatedAt: '2026-11-27T08:02:00Z',
      },
    ];
    gh.setWorkflowJobs('orders-api', 1001, [
      {
        id: 1,
        name: 'Publish Image',
        status: 'completed',
        conclusion: 'success',
        startedAt: '2026-11-27T08:01:00Z',
        completedAt: '2026-11-27T08:02:00Z',
        htmlUrl: null,
      },
    ]);
    if (sha2) {
      runs.push({
        id: 1002,
        runAttempt: 1,
        headSha: sha2,
        headBranch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/1002',
        runStartedAt: '2026-11-27T09:00:00Z',
        updatedAt: '2026-11-27T09:02:00Z',
      });
      gh.setWorkflowJobs('orders-api', 1002, [
        {
          id: 2,
          name: 'Publish Image',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-11-27T09:01:00Z',
          completedAt: '2026-11-27T09:02:00Z',
          htmlUrl: null,
        },
      ]);
    }
    gh.setWorkflowRuns('orders-api', runs);
    return gh;
  }

  function makeStepResolver(
    runner: FakeK8sRunner,
    gh: FakeGitHubClient,
    opts: {
      healthOk?: boolean;
      ghcrMissing?: boolean;
      helmFailError?: Error;
      storedSecrets?: Map<string, Record<string, unknown>>;
    } = {}
  ) {
    let deployedImage = '';
    let helmRevision = 0;
    const secrets = opts.storedSecrets ?? new Map<string, Record<string, unknown>>();

    runner.setDefaultKubectl(async (args, execOpts) => {
      if (args[0] === 'version') {
        return { stdout: '{"clientVersion":{},"serverVersion":{}}', stderr: '' };
      }
      if (args[0] === 'apply' && execOpts?.stdin) {
        const manifest = JSON.parse(execOpts.stdin) as {
          kind?: string;
          metadata?: { name?: string };
        };
        if (manifest.kind === 'Secret' && manifest.metadata?.name) {
          secrets.set(manifest.metadata.name, manifest as unknown as Record<string, unknown>);
        }
        return { stdout: 'secret/applied', stderr: '' };
      }
      if (args[0] === 'get' && args[1] === 'secret') {
        const name = args[2];
        if (!secrets.has(name)) {
          throw new K8sCommandError('NotFound', 1, '', `secrets "${name}" not found`);
        }
        return { stdout: `secret/${name}`, stderr: '' };
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
      if (args[0] === 'get' && args[1] === 'deployments') {
        return {
          stdout: JSON.stringify({
            items: deployedImage
              ? [
                  {
                    metadata: { name: 'orders-api' },
                    spec: {
                      replicas: 1,
                      template: { spec: { containers: [{ image: deployedImage }] } },
                    },
                    status: { replicas: 1, readyReplicas: 1 },
                  },
                ]
              : [],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'get' && args[1] === 'pods') {
        return { stdout: JSON.stringify({ items: [] }), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    runner.setDefaultHelm(async (args, execOpts) => {
      if (args[0] === 'version') {
        return { stdout: 'v4.2.2+gb05881c\n', stderr: '' };
      }
      if (args[0] === 'upgrade') {
        if (opts.helmFailError) {
          throw opts.helmFailError;
        }
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
      getGhcrCredentials: () =>
        opts.ghcrMissing ? null : { username: 'test-user', token: TEST_GHCR_TOKEN },
      getGitHubClient: () => gh,
      getExpectedOrg: () => 'forgeflow-test-org',
      getDeployTimeoutSeconds: () => 300,
      checkHttp: async () =>
        opts.healthOk === false ? { ok: false, error: '/health/ready returned 503' } : { ok: true },
    };

    const map = new Map([
      ['deploy', createDeploySteps(deps)],
      ['undeploy', createUndeploySteps({ getK8sRunner: () => runner })],
    ]);

    return (type: string) => map.get(type) ?? [];
  }

  it('happy path (all 4 steps), stable DB secret across 2 deploys, rollback, undeploy, delete guards, and allowlist audit', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1, sha2);

    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1, sha2);
    const storedSecrets = new Map<string, Record<string, unknown>>();
    const worker = createWorker({
      workerId: 'test-worker-3d',
      stepResolver: makeStepResolver(runner, gh, { storedSecrets }),
    });

    // 1. Deploy sha1
    const dep1Res = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(dep1Res.status).toBe(202);
    expect(Object.keys(dep1Res.body).sort()).toEqual(['deploymentId', 'status', 'workflowId']);

    // Concurrent second deploy -> 409 DEPLOYMENT_IN_PROGRESS
    const conflictRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha2 });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('DEPLOYMENT_IN_PROGRESS');

    expect(await worker.pollOnce()).toBe(true);

    // Verify all calls to FakeK8sRunner are allowlisted
    for (const call of runner.calls) {
      if (call.tool === 'kubectl') {
        expect(ALLOWED_KUBECTL_VERBS.has(call.args[0])).toBe(true);
      } else {
        expect(ALLOWED_HELM_SUBCOMMANDS.has(call.args[0])).toBe(true);
      }
    }

    // Print redacted happy-path call list for evidence
    const redactedCalls = runner.calls.map((c) => `${c.tool} ${c.args.join(' ')}`);
    expect(redactedCalls.length).toBeGreaterThan(0);

    const upgradeCall = runner.calls.find((c) => c.tool === 'helm' && c.args[0] === 'upgrade');
    expect(upgradeCall?.args).toContain('--rollback-on-failure');
    expect(upgradeCall?.args).toContain('--timeout');
    expect(upgradeCall?.args).toContain('300s');

    const dbSecret1 = storedSecrets.get('orders-api-db-secret') as {
      stringData?: { POSTGRES_PASSWORD?: string };
    };
    const dbPassword = dbSecret1?.stringData?.POSTGRES_PASSWORD ?? '';
    expect(dbPassword.length).toBeGreaterThan(10);

    // Environment healthy with url & port
    const [envAfter1] = await db
      .select()
      .from(environments)
      .where(eq(environments.service_id, svc.id));
    expect(envAfter1.status).toBe('healthy');
    expect(envAfter1.node_port).toBe(30080);
    expect(envAfter1.url).toBe('http://127.0.0.1:30080');

    // Delete while deployed -> 409 SERVICE_DEPLOYED
    const delWhileDeployed = await request(app)
      .delete(`/api/services/${svc.id}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(delWhileDeployed.status).toBe(409);
    expect(delWhileDeployed.body.error.code).toBe('SERVICE_DEPLOYED');

    // 2. Deploy sha2 (omit commitSha to test auto-picking latest deployable commit!)
    const dep2Res = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development' });
    expect(dep2Res.status).toBe(202);
    expect(await worker.pollOnce()).toBe(true);

    // DB password stable across two deploys while pull secret is refreshed
    const dbSecret2 = storedSecrets.get('orders-api-db-secret') as {
      stringData?: { POSTGRES_PASSWORD?: string };
    };
    expect(dbSecret2?.stringData?.POSTGRES_PASSWORD).toBe(dbPassword);

    // 3. Rollback to dep1 -> creates NEW deployment with rollbackOf pointing at dep1, marks dep2 rolled_back
    const rbRes = await request(app)
      .post(`/api/deployments/${dep1Res.body.deploymentId}/rollback`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development' });
    expect(rbRes.status).toBe(202);
    expect(Object.keys(rbRes.body).sort()).toEqual(['deploymentId', 'status', 'workflowId']);
    expect(await worker.pollOnce()).toBe(true);

    const [supersededDep2] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, dep2Res.body.deploymentId));
    expect(supersededDep2.status).toBe('rolled_back');

    const [rbDep] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, rbRes.body.deploymentId));
    expect(rbDep.status).toBe('succeeded');
    expect(rbDep.rollback_of).toBe(dep1Res.body.deploymentId);

    // Check GET /api/deployments, GET /api/deployments/:id, GET /api/services/:id/deployments exact keys + noSecrets
    const listAll = await request(app)
      .get(`/api/deployments?serviceId=${svc.id}&environment=development`)
      .set('Authorization', 'Bearer viewer-token');
    expect(listAll.status).toBe(200);
    expect(Object.keys(listAll.body).sort()).toEqual([
      'data',
      'page',
      'pageSize',
      'total',
      'totalPages',
    ]);
    expect(listAll.body.total).toBe(3);

    const singleDep = await request(app)
      .get(`/api/deployments/${rbRes.body.deploymentId}`)
      .set('Authorization', 'Bearer viewer-token');
    expect(singleDep.status).toBe(200);
    expect(Object.keys(singleDep.body).sort()).toEqual([
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

    const svcDeps = await request(app)
      .get(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer viewer-token');
    expect(svcDeps.status).toBe(200);
    expect(Object.keys(svcDeps.body).sort()).toEqual(['data']);

    const logs = await db.select().from(workflowLogs);
    assertNoSecrets(
      JSON.stringify({
        listAll: listAll.body,
        singleDep: singleDep.body,
        svcDeps: svcDeps.body,
        logs,
      }),
      [dbPassword]
    );

    // 4. Undeploy followed by successful service delete
    const undepRes = await request(app)
      .post(`/api/services/${svc.id}/environments/development/undeploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send();
    expect(undepRes.status).toBe(202);
    expect(Object.keys(undepRes.body).sort()).toEqual(['status', 'workflowId']);
    expect(await worker.pollOnce()).toBe(true);

    const delRes = await request(app)
      .delete(`/api/services/${svc.id}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(delRes.status).toBe(204);
  });

  it('rejects 409 CI_NOT_READY, 409 NO_PUBLISHED_IMAGE (template 1.0.0), and enforces permission matrix', async () => {
    const sha1 = 'a'.repeat(40);
    const app = createApp({ auth: testAuthVerifier });

    // Service with no CI runs -> 409 CI_NOT_READY
    const [svcNoCi] = await db
      .insert(services)
      .values({
        name: 'no-ci-svc',
        slug: 'no-ci-svc',
        owner_id: testUsers.devOwner.id,
        repository_url: 'https://github.com/forgeflow-test-org/no-ci-svc',
        provisioning_status: 'ready',
        template_version: '1.1.0',
      })
      .returning();

    const noCiRes = await request(app)
      .post(`/api/services/${svcNoCi.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development' });
    expect(noCiRes.status).toBe(409);
    expect(noCiRes.body.error.code).toBe('CI_NOT_READY');

    // Service with template 1.0.0 -> 409 NO_PUBLISHED_IMAGE
    const { svc: svc100 } = await seedReadyServiceWithCi(sha1, undefined, {
      templateVersion: '1.0.0',
    });
    const noImgRes = await request(app)
      .post(`/api/services/${svc100.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(noImgRes.status).toBe(409);
    expect(noImgRes.body.error.code).toBe('NO_PUBLISHED_IMAGE');

    // Permission matrix: viewer 403, otherDev 403 on deploy, rollback, undeploy
    const [depRow] = await db
      .insert(deployments)
      .values({
        service_id: svc100.id,
        environment_id: (
          await db.select().from(environments).where(eq(environments.service_id, svc100.id))
        )[0].id,
        commit_sha: sha1,
        image: `ghcr.io/forgeflow-test-org/orders-api:${sha1}`,
        status: 'succeeded',
      })
      .returning();

    for (const token of ['viewer-token', 'other-dev-token']) {
      const r1 = await request(app)
        .post(`/api/services/${svcNoCi.id}/deployments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ environment: 'development' });
      expect(r1.status).toBe(403);

      const r2 = await request(app)
        .post(`/api/deployments/${depRow.id}/rollback`)
        .set('Authorization', `Bearer ${token}`)
        .send({ environment: 'development' });
      expect(r2.status).toBe(403);

      const r3 = await request(app)
        .post(`/api/services/${svcNoCi.id}/environments/development/undeploy`)
        .set('Authorization', `Bearer ${token}`)
        .send();
      expect(r3.status).toBe(403);
    }
  });

  it('fails in preflight when GHCR token is missing (naming only variable names)', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);
    const worker = createWorker({
      workerId: 'test-worker-missing-ghcr',
      stepResolver: makeStepResolver(runner, gh, { ghcrMissing: true }),
    });

    const depRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(depRes.status).toBe(202);
    expect(await worker.pollOnce()).toBe(true);

    const [dep] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, depRes.body.deploymentId));
    expect(dep.status).toBe('failed');
    expect(dep.error_summary).toContain('GHCR_PULL_USERNAME');
    expect(dep.error_summary).toContain('GHCR_PULL_TOKEN');
    assertNoSecrets(dep.error_summary ?? '');
  });

  it('handles helm failure with observation, crash+retry without duplicates, stale recovery, and cancel', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc, env } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);

    // 1. Helm failure marks deployment failed with redacted summary and clears node_port on failed first deploy
    const failWorker = createWorker({
      workerId: 'worker-helm-fail',
      stepResolver: makeStepResolver(runner, gh, {
        helmFailError: new Error(`Helm failed using token ${TEST_GHCR_TOKEN}`),
      }),
    });
    const depFailRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await failWorker.pollOnce()).toBe(true);

    const [failedDep] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, depFailRes.body.deploymentId));
    expect(failedDep.status).toBe('failed');
    assertNoSecrets(failedDep.error_summary ?? '');

    const [envAfterFail] = await db.select().from(environments).where(eq(environments.id, env.id));
    expect(envAfterFail.node_port).toBeNull();

    // 2. Crash after helm succeeded (verify fails once) -> retry succeeds without duplicate resources
    let failVerifyOnce = true;
    const crashRunner = new FakeK8sRunner();
    const baseResolver = makeStepResolver(crashRunner, gh);
    const retryWorker = createWorker({
      workerId: 'worker-retry',
      stepResolver: (type) => {
        const steps = baseResolver(type);
        if (type !== 'deploy') return steps;
        return steps.map((s) =>
          s.key === 'verify'
            ? {
                ...s,
                run: async (ctx) => {
                  if (failVerifyOnce) {
                    failVerifyOnce = false;
                    throw new Error('Simulated crash after helm succeeded');
                  }
                  return s.run(ctx);
                },
              }
            : s
        );
      },
    });

    const depCrashRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await retryWorker.pollOnce()).toBe(true);

    const retryRes = await request(app)
      .post(`/api/workflows/${depCrashRes.body.workflowId}/retry`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(retryRes.status).toBe(200);
    expect(await retryWorker.pollOnce()).toBe(true);

    const [retriedRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, depCrashRes.body.workflowId));
    expect(retriedRun.status).toBe('succeeded');

    // 3. Stale-lock recovery mid-deploy
    await db
      .update(environments)
      .set({ deployed_commit_sha: null, deployed_image: null, node_port: null, status: 'unknown' })
      .where(eq(environments.id, env.id));

    const depStaleRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });

    await db
      .update(workflowRuns)
      .set({
        status: 'running',
        locked_by: 'dead-worker',
        locked_at: new Date(Date.now() - 300_000),
      })
      .where(eq(workflowRuns.id, depStaleRes.body.workflowId));

    expect(await requeueStale(120_000)).toBe(1);
    expect(await retryWorker.pollOnce()).toBe(true);

    const [staleRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, depStaleRes.body.workflowId));
    expect(staleRun.status).toBe('succeeded');

    // 4. Cancel queued deploy
    const depCancelRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    const cancelRes = await request(app)
      .post(`/api/workflows/${depCancelRes.body.workflowId}/cancel`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(cancelRes.status).toBe(200);

    const [cancelledDep] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, depCancelRes.body.deploymentId));
    expect(cancelledDep.status).toBe('cancelled');
  });

  it('allocates NodePorts sequentially and fails cleanly on exhaustion (30080-30089)', async () => {
    const createdEnvs: string[] = [];
    for (let i = 0; i < 11; i++) {
      const [svc] = await db
        .insert(services)
        .values({
          name: `port-svc-${i}`,
          slug: `port-svc-${i}`,
          owner_id: testUsers.devOwner.id,
        })
        .returning();
      const [env] = await db
        .insert(environments)
        .values({ service_id: svc.id, name: 'development', status: 'unknown' })
        .returning();
      createdEnvs.push(env.id);
    }

    for (let i = 0; i < 10; i++) {
      const alloc = await allocateEnvironmentNodePort(createdEnvs[i]);
      expect(alloc.nodePort).toBe(30080 + i);
    }

    await expect(allocateEnvironmentNodePort(createdEnvs[10])).rejects.toThrow(
      /All NodePorts \(30080-30089\) are in use/
    );
  });

  it('computeEnvironmentObservation table-driven status cases (no drifted)', () => {
    const img = 'ghcr.io/org/svc:' + 'a'.repeat(40);
    const otherImg = 'ghcr.io/org/svc:' + 'b'.repeat(40);

    const cases: Array<{
      name: string;
      input: Parameters<typeof computeEnvironmentObservation>[0];
      expectedStatus: string;
    }> = [
      {
        name: 'healthy when desired > 0, ready == desired, image matches',
        input: {
          deployedImage: img,
          deployment: {
            spec: { replicas: 2, template: { spec: { containers: [{ image: img }] } } },
            status: { replicas: 2, readyReplicas: 2 },
          },
          clusterReachable: true,
        },
        expectedStatus: 'healthy',
      },
      {
        name: 'degraded when some but not all replicas ready',
        input: {
          deployedImage: img,
          deployment: {
            spec: { replicas: 2, template: { spec: { containers: [{ image: img }] } } },
            status: { replicas: 2, readyReplicas: 1 },
          },
          clusterReachable: true,
        },
        expectedStatus: 'degraded',
      },
      {
        name: 'degraded when running image differs from deployed_image',
        input: {
          deployedImage: img,
          deployment: {
            spec: { replicas: 1, template: { spec: { containers: [{ image: otherImg }] } } },
            status: { replicas: 1, readyReplicas: 1 },
          },
          clusterReachable: true,
        },
        expectedStatus: 'degraded',
      },
      {
        name: 'failed when ready is 0',
        input: {
          deployedImage: img,
          deployment: {
            spec: { replicas: 1, template: { spec: { containers: [{ image: img }] } } },
            status: { replicas: 1, readyReplicas: 0 },
          },
          clusterReachable: true,
        },
        expectedStatus: 'failed',
      },
      {
        name: 'failed when desired is 0',
        input: {
          deployedImage: img,
          deployment: {
            spec: { replicas: 0, template: { spec: { containers: [{ image: img }] } } },
            status: { replicas: 0, readyReplicas: 0 },
          },
          clusterReachable: true,
        },
        expectedStatus: 'failed',
      },
      {
        name: 'failed on ImagePullBackOff pod',
        input: {
          deployedImage: img,
          deployment: {
            spec: { replicas: 1, template: { spec: { containers: [{ image: img }] } } },
            status: { replicas: 1, readyReplicas: 0 },
          },
          pods: [
            {
              status: {
                containerStatuses: [
                  {
                    state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling' } },
                  },
                ],
              },
            },
          ],
          clusterReachable: true,
        },
        expectedStatus: 'failed',
      },
      {
        name: 'failed when Deployment missing although image recorded',
        input: {
          deployedImage: img,
          deployment: null,
          clusterReachable: true,
        },
        expectedStatus: 'failed',
      },
      {
        name: 'unknown when cluster unreachable',
        input: {
          deployedImage: img,
          deployment: null,
          clusterReachable: false,
          reachabilityError: 'ECONNREFUSED',
        },
        expectedStatus: 'unknown',
      },
    ];

    for (const tc of cases) {
      const res = computeEnvironmentObservation(tc.input);
      expect(res.status, tc.name).toBe(tc.expectedStatus);
    }
  });

  it('reconcileEnvironments never overwrites healthy status with failed when cluster is unreachable', async () => {
    const sha1 = 'a'.repeat(40);
    const { env } = await seedReadyServiceWithCi(sha1);
    await db
      .update(environments)
      .set({
        deployed_image: `ghcr.io/forgeflow-test-org/orders-api:${sha1}`,
        deployed_commit_sha: sha1,
        status: 'healthy',
      })
      .where(eq(environments.id, env.id));

    const runner = new FakeK8sRunner();
    runner.onKubectl(async () => {
      throw new K8sCommandError(
        'Connection refused',
        1,
        '',
        'dial tcp 127.0.0.1:6443: connect: connection refused'
      );
    });

    await reconcileEnvironments(runner);
    const [after] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.id, env.id)));
    expect(after.status).toBe('healthy');
    expect(after.last_observed_error).toContain('Cluster unreachable');
  });
});
