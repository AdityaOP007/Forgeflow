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
      podFailureOnFail?: boolean;
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
                    status: {
                      replicas: 1,
                      readyReplicas: opts.podFailureOnFail ? 0 : 1,
                    },
                  },
                ]
              : [],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'get' && args[1] === 'pods') {
        return {
          stdout: JSON.stringify({
            items: opts.podFailureOnFail
              ? [
                  {
                    metadata: { name: 'orders-api-abc' },
                    status: {
                      containerStatuses: [
                        {
                          state: {
                            waiting: {
                              reason: 'ImagePullBackOff',
                              message: 'unauthorized: invalid token',
                            },
                          },
                        },
                      ],
                    },
                  },
                ]
              : [],
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

  it('happy path: runs all 4 steps, marks deployment succeeded, environment healthy with url and nodePort', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);
    const worker = createWorker({
      workerId: 'worker-happy',
      stepResolver: makeStepResolver(runner, gh),
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
    expect(dep.status).toBe('succeeded');
    expect(dep.helm_revision).toBe(1);

    const [env] = await db.select().from(environments).where(eq(environments.service_id, svc.id));
    expect(env.status).toBe('healthy');
    expect(env.node_port).toBe(30080);
    expect(env.url).toBe('http://127.0.0.1:30080');
  });

  it('returns exact camelCase key sets for all new deployment and CI responses', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1, sha2);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1, sha2);
    const worker = createWorker({
      workerId: 'worker-keys',
      stepResolver: makeStepResolver(runner, gh),
    });

    // deployment create 202
    const dep1Res = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(dep1Res.status).toBe(202);
    expect(Object.keys(dep1Res.body).sort()).toEqual(['deploymentId', 'status', 'workflowId']);
    expect(await worker.pollOnce()).toBe(true);

    // rollback 202
    const rbRes = await request(app)
      .post(`/api/deployments/${dep1Res.body.deploymentId}/rollback`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development' });
    expect(rbRes.status).toBe(202);
    expect(Object.keys(rbRes.body).sort()).toEqual(['deploymentId', 'status', 'workflowId']);
    expect(await worker.pollOnce()).toBe(true);

    // deployments list (paginated)
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

    // deployment detail
    const detail = await request(app)
      .get(`/api/deployments/${dep1Res.body.deploymentId}`)
      .set('Authorization', 'Bearer viewer-token');
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body).sort()).toEqual([
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

    // service deployments list
    const svcDeps = await request(app)
      .get(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer viewer-token');
    expect(svcDeps.status).toBe(200);
    expect(Object.keys(svcDeps.body).sort()).toEqual(['data']);

    // deployable-commits
    const deployable = await request(app)
      .get(`/api/services/${svc.id}/deployable-commits`)
      .set('Authorization', 'Bearer viewer-token');
    expect(deployable.status).toBe(200);
    expect(Object.keys(deployable.body).sort()).toEqual(['data']);
    expect(Object.keys(deployable.body.data[0]).sort()).toEqual([
      'ciRunId',
      'commitSha',
      'completedAt',
      'htmlUrl',
      'shortSha',
    ]);

    // ci-runs
    const ciRes = await request(app)
      .get(`/api/services/${svc.id}/ci-runs`)
      .set('Authorization', 'Bearer viewer-token');
    expect(ciRes.status).toBe(200);
    expect(Object.keys(ciRes.body).sort()).toEqual(['data']);
    expect(Object.keys(ciRes.body.data[0]).sort()).toEqual([
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

    // undeploy 202
    const undepRes = await request(app)
      .post(`/api/services/${svc.id}/environments/development/undeploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send();
    expect(undepRes.status).toBe(202);
    expect(Object.keys(undepRes.body).sort()).toEqual(['status', 'workflowId']);
  });

  it('assertNoSecrets excludes DB password, GHCR token, and dockerconfigjson from responses, logs, and errors', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);
    const storedSecrets = new Map<string, Record<string, unknown>>();
    const worker = createWorker({
      workerId: 'worker-secrets',
      stepResolver: makeStepResolver(runner, gh, { storedSecrets }),
    });

    const depRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await worker.pollOnce()).toBe(true);

    const dbSecret = storedSecrets.get('orders-api-db-secret') as {
      stringData?: { POSTGRES_PASSWORD?: string; DATABASE_URL?: string };
    };
    const dbPassword = dbSecret?.stringData?.POSTGRES_PASSWORD ?? '';
    expect(dbPassword.length).toBeGreaterThan(10);

    const detail = await request(app)
      .get(`/api/deployments/${depRes.body.deploymentId}`)
      .set('Authorization', 'Bearer viewer-token');
    const logs = await db.select().from(workflowLogs);

    assertNoSecrets(JSON.stringify({ depRes: depRes.body, detail: detail.body, logs }), [
      dbPassword,
    ]);
  });

  it('returns 409 CI_NOT_READY when service has no completed green CI run on main', async () => {
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

    const app = createApp({ auth: testAuthVerifier });
    const res = await request(app)
      .post(`/api/services/${svcNoCi.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CI_NOT_READY');
  });

  it('returns 409 NO_PUBLISHED_IMAGE for template 1.0.0 service', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1, undefined, { templateVersion: '1.0.0' });
    const app = createApp({ auth: testAuthVerifier });
    const res = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_PUBLISHED_IMAGE');
  });

  it('returns 409 DEPLOYMENT_IN_PROGRESS on concurrent second deploy', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1, sha2);
    const app = createApp({ auth: testAuthVerifier });

    const r1 = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(r1.status).toBe(202);

    const r2 = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha2 });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('DEPLOYMENT_IN_PROGRESS');
  });

  it('keeps database secret password stable across two deploys while refreshing GHCR pull secret', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1, sha2);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1, sha2);
    const storedSecrets = new Map<string, Record<string, unknown>>();
    const worker = createWorker({
      workerId: 'worker-stable-secret',
      stepResolver: makeStepResolver(runner, gh, { storedSecrets }),
    });

    await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await worker.pollOnce()).toBe(true);

    const dbSecret1 = storedSecrets.get('orders-api-db-secret') as {
      stringData?: { POSTGRES_PASSWORD?: string };
    };
    const pw1 = dbSecret1.stringData?.POSTGRES_PASSWORD;
    const pullCalls1 = runner.calls.filter(
      (c) => c.tool === 'kubectl' && c.args[0] === 'apply' && c.stdin?.includes('dockerconfigjson')
    );
    expect(pullCalls1).toHaveLength(1);

    await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha2 });
    expect(await worker.pollOnce()).toBe(true);

    const dbSecret2 = storedSecrets.get('orders-api-db-secret') as {
      stringData?: { POSTGRES_PASSWORD?: string };
    };
    expect(dbSecret2.stringData?.POSTGRES_PASSWORD).toBe(pw1);
    const pullCalls2 = runner.calls.filter(
      (c) => c.tool === 'kubectl' && c.args[0] === 'apply' && c.stdin?.includes('dockerconfigjson')
    );
    expect(pullCalls2).toHaveLength(2);
  });

  it('marks deployment failed with redacted summary on helm failure and observes cluster state', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc, env } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);
    const worker = createWorker({
      workerId: 'worker-helm-fail',
      stepResolver: makeStepResolver(runner, gh, {
        helmFailError: new Error(`Helm failed with token ${TEST_GHCR_TOKEN}`),
      }),
    });

    const depRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await worker.pollOnce()).toBe(true);

    const [failedDep] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, depRes.body.deploymentId));
    expect(failedDep.status).toBe('failed');
    expect(failedDep.error_summary).toContain('[REDACTED_TOKEN]');
    assertNoSecrets(failedDep.error_summary ?? '');

    // Failed first deploy does not leak node_port
    const [envRow] = await db.select().from(environments).where(eq(environments.id, env.id));
    expect(envRow.node_port).toBeNull();
  });

  it('recovers from crash after helm succeeded and before recording via retry without duplicate resources', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);

    let failVerifyOnce = true;
    const baseResolver = makeStepResolver(runner, gh);
    const worker = createWorker({
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

    const depRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await worker.pollOnce()).toBe(true);

    const retryRes = await request(app)
      .post(`/api/workflows/${depRes.body.workflowId}/retry`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(retryRes.status).toBe(200);
    expect(await worker.pollOnce()).toBe(true);

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, depRes.body.workflowId));
    expect(run.status).toBe('succeeded');

    // helm upgrade ran only once (deploy step was skipped on retry)
    const helmUpgrades = runner.calls.filter((c) => c.tool === 'helm' && c.args[0] === 'upgrade');
    expect(helmUpgrades).toHaveLength(1);
  });

  it('recovers mid-deploy from stale lock via requeueStale', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);
    const worker = createWorker({
      workerId: 'worker-stale',
      stepResolver: makeStepResolver(runner, gh),
    });

    const depRes = await request(app)
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
      .where(eq(workflowRuns.id, depRes.body.workflowId));

    expect(await requeueStale(120_000)).toBe(1);
    expect(await worker.pollOnce()).toBe(true);

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, depRes.body.workflowId));
    expect(run.status).toBe('succeeded');
  });

  it('cancels queued deploy workflow and marks deployment cancelled', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });

    const depRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });

    const cancelRes = await request(app)
      .post(`/api/workflows/${depRes.body.workflowId}/cancel`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(cancelRes.status).toBe(200);

    const [dep] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, depRes.body.deploymentId));
    expect(dep.status).toBe('cancelled');
  });

  it('rollback creates a new deployment and marks only previously current deployment rolled_back while target stays succeeded', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1, sha2);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1, sha2);
    const worker = createWorker({
      workerId: 'worker-rb',
      stepResolver: makeStepResolver(runner, gh),
    });

    const dep1 = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await worker.pollOnce()).toBe(true);

    const dep2 = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha2 });
    expect(await worker.pollOnce()).toBe(true);

    // Roll back to dep1
    const rb = await request(app)
      .post(`/api/deployments/${dep1.body.deploymentId}/rollback`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development' });
    expect(rb.status).toBe(202);
    expect(await worker.pollOnce()).toBe(true);

    const [row1] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, dep1.body.deploymentId));
    const [row2] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, dep2.body.deploymentId));
    const [rowRb] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, rb.body.deploymentId));

    expect(row1.status).toBe('succeeded'); // target stays succeeded!
    expect(row2.status).toBe('rolled_back'); // previously current becomes rolled_back!
    expect(rowRb.status).toBe('succeeded');
    expect(rowRb.rollback_of).toBe(dep1.body.deploymentId);

    // Target dep1 can be rolled back to again
    const rbAgain = await request(app)
      .post(`/api/deployments/${dep1.body.deploymentId}/rollback`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development' });
    expect(rbAgain.status).toBe(202);
  });

  it('undeploy clears state and allows service delete while delete-while-deployed returns 409 SERVICE_DEPLOYED', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);
    const worker = createWorker({
      workerId: 'worker-undep',
      stepResolver: makeStepResolver(runner, gh),
    });

    await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await worker.pollOnce()).toBe(true);

    const delBlocked = await request(app)
      .delete(`/api/services/${svc.id}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(delBlocked.status).toBe(409);
    expect(delBlocked.body.error.code).toBe('SERVICE_DEPLOYED');

    const undepRes = await request(app)
      .post(`/api/services/${svc.id}/environments/development/undeploy`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send();
    expect(undepRes.status).toBe(202);
    expect(await worker.pollOnce()).toBe(true);

    const delOk = await request(app)
      .delete(`/api/services/${svc.id}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(delOk.status).toBe(204);
  });

  it('allocates NodePorts sequentially, handles concurrent race, and fails on exhaustion', async () => {
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

    // Concurrent race on 2 envs -> both get distinct ports
    const [r1, r2] = await Promise.all([
      allocateEnvironmentNodePort(createdEnvs[0]),
      allocateEnvironmentNodePort(createdEnvs[1]),
    ]);
    expect(r1.nodePort).not.toBe(r2.nodePort);
    expect([r1.nodePort, r2.nodePort].every((p) => p >= 30080 && p <= 30089)).toBe(true);

    for (let i = 2; i < 10; i++) {
      const alloc = await allocateEnvironmentNodePort(createdEnvs[i]);
      expect(alloc.nodePort).toBeGreaterThanOrEqual(30080);
      expect(alloc.nodePort).toBeLessThanOrEqual(30089);
    }

    await expect(allocateEnvironmentNodePort(createdEnvs[10])).rejects.toThrow(
      /All NodePorts \(30080-30089\) are in use/
    );
  });

  it('every call reaching FakeK8sRunner is allowlisted and prints redacted happy-path call list', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);
    const worker = createWorker({
      workerId: 'worker-allowlist',
      stepResolver: makeStepResolver(runner, gh),
    });

    await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
    expect(await worker.pollOnce()).toBe(true);

    const callList = runner.calls.map((c) => {
      if (c.tool === 'kubectl') expect(ALLOWED_KUBECTL_VERBS.has(c.args[0])).toBe(true);
      else expect(ALLOWED_HELM_SUBCOMMANDS.has(c.args[0])).toBe(true);
      return `${c.tool} ${c.args.join(' ')}`;
    });

    console.log('Happy-path FakeK8sRunner calls:\n' + callList.join('\n'));
    expect(callList.length).toBeGreaterThanOrEqual(7);
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
                  { state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off' } } },
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
        input: { deployedImage: img, deployment: null, clusterReachable: true },
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
      expect(computeEnvironmentObservation(tc.input).status, tc.name).toBe(tc.expectedStatus);
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
      throw new K8sCommandError('Connection refused', 1, '', 'dial tcp 127.0.0.1:6443: refused');
    });

    await reconcileEnvironments(runner);
    const [after] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.id, env.id)));
    expect(after.status).toBe('healthy');
    expect(after.last_observed_error).toContain('Cluster unreachable');
  });

  it('enforces permission matrix: viewer 403 and different developer 403 on deploy, rollback, and undeploy', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc, env } = await seedReadyServiceWithCi(sha1);
    const [dep] = await db
      .insert(deployments)
      .values({
        service_id: svc.id,
        environment_id: env.id,
        commit_sha: sha1,
        image: `ghcr.io/forgeflow-test-org/orders-api:${sha1}`,
        status: 'succeeded',
      })
      .returning();

    const app = createApp({ auth: testAuthVerifier });
    for (const token of ['viewer-token', 'other-dev-token']) {
      expect(
        (
          await request(app)
            .post(`/api/services/${svc.id}/deployments`)
            .set('Authorization', `Bearer ${token}`)
            .send({ environment: 'development', commitSha: sha1 })
        ).status
      ).toBe(403);

      expect(
        (
          await request(app)
            .post(`/api/deployments/${dep.id}/rollback`)
            .set('Authorization', `Bearer ${token}`)
            .send({ environment: 'development' })
        ).status
      ).toBe(403);

      expect(
        (
          await request(app)
            .post(`/api/services/${svc.id}/environments/development/undeploy`)
            .set('Authorization', `Bearer ${token}`)
            .send()
        ).status
      ).toBe(403);
    }
  });

  it('fails in preflight when GHCR credentials are missing (naming only variable names)', async () => {
    const sha1 = 'a'.repeat(40);
    const { svc } = await seedReadyServiceWithCi(sha1);
    const app = createApp({ auth: testAuthVerifier });
    const runner = new FakeK8sRunner();
    const gh = makeFakeGitHub(sha1);
    const worker = createWorker({
      workerId: 'worker-missing-ghcr',
      stepResolver: makeStepResolver(runner, gh, { ghcrMissing: true }),
    });

    const depRes = await request(app)
      .post(`/api/services/${svc.id}/deployments`)
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ environment: 'development', commitSha: sha1 });
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
});
