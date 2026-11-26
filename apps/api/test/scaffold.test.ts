import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { templates, workflowRuns, workflowSteps } from '../src/db/schema.js';
import { testAuthVerifier } from './setup.js';
import { FakeGitHubClient } from './fakes/fake-github-client.js';
import { createScaffoldSteps } from '../src/workflows/steps/scaffold.js';
import { claimNext, requeueStale } from '../src/workflows/queue.js';
import { executeWorkflow } from '../src/workflows/executor.js';
import { renderTemplate } from '../src/templates/engine.js';

describe('Scaffold Workflows & API — Checkpoint 2D', () => {
  let fakeGitHub: FakeGitHubClient;
  let fastApiTemplateId: string;
  let nodeTemplateId: string;

  beforeEach(async () => {
    fakeGitHub = new FakeGitHubClient({ org: 'forgeflow-test-org' });

    const allTemplates = await db.select().from(templates);
    fastApiTemplateId = allTemplates.find((t) => t.slug === 'python-fastapi')!.id;
    nodeTemplateId = allTemplates.find((t) => t.slug === 'node-express')!.id;
  });

  function makeTestApp(githubConfigured = true) {
    return createApp({
      auth: testAuthVerifier,
      services: { isGitHubConfigured: () => githubConfigured },
      integrations: {
        createClient: () => fakeGitHub,
      },
    });
  }

  function assertNoSecrets(payload: unknown) {
    const text = JSON.stringify(payload);
    expect(text).not.toContain('ghs_');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('github_pat_');
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(text).not.toContain('Bearer ');
  }

  function makeSteps(client: FakeGitHubClient = fakeGitHub) {
    return createScaffoldSteps({
      getGitHubClient: () => client,
      getGitHubOrg: () => client.org,
    });
  }

  it('full happy path: scaffold -> worker executes 4 steps -> service ready, resources saved, committed files match rendered set', async () => {
    const app = makeTestApp(true);

    const res = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({
        name: 'inventory-api',
        description: 'Tracks warehouse inventory.',
        templateId: fastApiTemplateId,
        database: 'postgresql',
        repositoryVisibility: 'private',
        environment: 'local-docker',
      });

    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['serviceId', 'status', 'workflowId']);
    expect(res.body.status).toBe('queued');

    const { serviceId, workflowId } = res.body;

    // Claim and execute with worker
    const claimed = await claimNext('worker-2d-happy');
    expect(claimed?.id).toBe(workflowId);

    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-2d-happy',
      steps: makeSteps(),
    });

    // Verify workflow detail endpoint & exact camelCase key set
    const wfRes = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer viewer-token');
    expect(wfRes.status).toBe(200);
    expect(Object.keys(wfRes.body).sort()).toEqual(
      [
        'attempts',
        'cancelRequested',
        'completedAt',
        'createdAt',
        'createdBy',
        'errorSummary',
        'failedStepKey',
        'id',
        'input',
        'lockedAt',
        'lockedBy',
        'resources',
        'serviceId',
        'serviceName',
        'serviceSlug',
        'startedAt',
        'status',
        'steps',
        'type',
      ].sort()
    );
    expect(wfRes.body.status).toBe('succeeded');
    expect(wfRes.body.failedStepKey).toBeNull();
    expect(wfRes.body.steps).toHaveLength(4);
    expect(wfRes.body.steps.every((s: { status: string }) => s.status === 'succeeded')).toBe(true);
    expect(wfRes.body.resources.template).toEqual({
      slug: 'python-fastapi',
      version: '1.1.0',
      fileCount: 21,
    });
    expect(wfRes.body.resources.repository.fullName).toBe('forgeflow-test-org/inventory-api');
    expect(wfRes.body.resources.commit.sha).toMatch(/^[a-f0-9]{40}$/);

    // Verify committed files in FakeGitHubClient equal the rendered set
    const storedRepo = fakeGitHub.repos.get('inventory-api')!;
    const branchState = storedRepo.branches.get('main')!;
    const latestCommit = branchState.commits[branchState.commits.length - 1];
    expect(latestCommit.message).toContain(`ForgeFlow-Workflow: ${workflowId}`);

    const expectedRendered = renderTemplate('python-fastapi', {
      serviceName: 'inventory-api',
      description: 'Tracks warehouse inventory.',
      templateVersion: '1.1.0',
    });
    expect(latestCommit.files.size).toBe(expectedRendered.length);
    for (const f of expectedRendered) {
      expect(latestCommit.files.get(f.path)).toBe(f.content);
    }

    // Verify service detail includes provisioningStatus, templateVersion, latestWorkflowId
    const svcRes = await request(app)
      .get(`/api/services/${serviceId}`)
      .set('Authorization', 'Bearer viewer-token');
    expect(svcRes.status).toBe(200);
    expect(svcRes.body.provisioningStatus).toBe('ready');
    expect(svcRes.body.templateVersion).toBe('1.1.0');
    expect(svcRes.body.latestWorkflowId).toBe(workflowId);
    expect(svcRes.body.repositoryUrl).toBe('https://github.com/forgeflow-test-org/inventory-api');

    // Verify logs endpoint with after cursor & no secrets
    const logsRes = await request(app)
      .get(`/api/workflows/${workflowId}/logs?after=0&limit=200`)
      .set('Authorization', 'Bearer viewer-token');
    expect(logsRes.status).toBe(200);
    expect(Object.keys(logsRes.body).sort()).toEqual(['logs', 'nextCursor']);
    expect(logsRes.body.logs.length).toBeGreaterThanOrEqual(4);
    const logItemKeys = Object.keys(logsRes.body.logs[0]).sort();
    expect(logItemKeys).toEqual([
      'createdAt',
      'id',
      'level',
      'message',
      'stepKey',
      'workflowRunId',
    ]);
    for (const k of logItemKeys) expect(k).not.toContain('_');
    expect(logsRes.body.nextCursor).toBe(logsRes.body.logs[logsRes.body.logs.length - 1].id);
    assertNoSecrets(res.body);
    assertNoSecrets(wfRes.body);
    assertNoSecrets(svcRes.body);
    assertNoSecrets(logsRes.body);
  });

  it('crash after repository is created before saving, then retry, ends with exactly ONE repository', async () => {
    const app = makeTestApp(true);

    const res = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({
        name: 'crash-adopt-svc',
        description: 'Crash recovery test',
        templateId: fastApiTemplateId,
      });
    expect(res.status).toBe(202);
    const { workflowId } = res.body;

    // Inject crash right after createRepository stores the repo
    fakeGitHub.setThrowAfterCreate(new Error('Simulated worker crash after repo creation'));

    await claimNext('worker-crash-1');
    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-crash-1',
      steps: makeSteps(),
    });

    const failedWf = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(failedWf.body.status).toBe('failed');
    expect(failedWf.body.failedStepKey).toBe('create_repository');
    expect(fakeGitHub.repos.size).toBe(1);

    // Retry
    const retryRes = await request(app)
      .post(`/api/workflows/${workflowId}/retry`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.status).toBe('queued');

    await claimNext('worker-crash-2');
    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-crash-2',
      steps: makeSteps(),
    });

    const finalWf = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(finalWf.body.status).toBe('succeeded');
    expect(fakeGitHub.repos.size).toBe(1);
  });

  it('foreign repository with the same name fails at validate with clear message and creates nothing', async () => {
    const app = makeTestApp(true);

    // Pre-create foreign repository without ForgeFlow marker
    await fakeGitHub.createRepository({
      name: 'taken-repo',
      description: 'Manually created unrelated repository',
      private: true,
    });

    const res = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({
        name: 'taken-repo',
        description: 'Trying to collide',
        templateId: fastApiTemplateId,
      });
    expect(res.status).toBe(202);
    const { workflowId } = res.body;

    await claimNext('worker-foreign');
    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-foreign',
      steps: makeSteps(),
    });

    const wfRes = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(wfRes.body.status).toBe('failed');
    expect(wfRes.body.failedStepKey).toBe('validate');
    expect(wfRes.body.errorSummary).toBe(
      'A repository named taken-repo already exists in forgeflow-test-org that this service did not create. Choose a different service name.'
    );
    expect(fakeGitHub.repos.size).toBe(1);
  });

  it('repository with another service ownership marker fails at validate and leaves repository untouched', async () => {
    const app = makeTestApp(true);

    // Pre-create repository with a DIFFERENT service ForgeFlow marker
    await fakeGitHub.createRepository({
      name: 'other-marker-repo',
      description: 'Previous service [forgeflow:000000000000]',
      private: true,
    });
    const beforeHead = await fakeGitHub.getHeadCommit('other-marker-repo', 'main');

    const res = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({
        name: 'other-marker-repo',
        description: 'Should not adopt another service marker',
        templateId: fastApiTemplateId,
      });
    expect(res.status).toBe(202);
    const { workflowId } = res.body;

    await claimNext('worker-other-marker');
    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-other-marker',
      steps: makeSteps(),
    });

    const wfRes = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(wfRes.body.status).toBe('failed');
    expect(wfRes.body.failedStepKey).toBe('validate');
    expect(wfRes.body.errorSummary).toBe(
      'A repository named other-marker-repo already exists in forgeflow-test-org that this service did not create. Choose a different service name.'
    );

    const afterHead = await fakeGitHub.getHeadCommit('other-marker-repo', 'main');
    expect(afterHead).toEqual(beforeHead);
    expect(fakeGitHub.repos.get('other-marker-repo')?.branches.get('main')?.commits).toHaveLength(
      1
    );
  });

  it('repo creation failure, then fix, then retry succeeds', async () => {
    const app = makeTestApp(true);

    const res = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({
        name: 'flaky-repo-svc',
        templateId: fastApiTemplateId,
      });
    const { workflowId } = res.body;

    // validate does 2 calls (getInstallationInfo + getRepository); fail on 3rd call (createRepository)
    fakeGitHub.setFailAfterNCalls(2);

    await claimNext('worker-flaky-1');
    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-flaky-1',
      steps: makeSteps(),
    });

    const afterFail = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(afterFail.body.status).toBe('failed');
    expect(afterFail.body.failedStepKey).toBe('create_repository');

    // Fix upstream & retry
    fakeGitHub.clearFailureInjection();
    const retryRes = await request(app)
      .post(`/api/workflows/${workflowId}/retry`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(retryRes.status).toBe(200);

    await claimNext('worker-flaky-2');
    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-flaky-2',
      steps: makeSteps(),
    });

    const finalWf = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(finalWf.body.status).toBe('succeeded');
  });

  it('cancel during a running workflow stops before next step and terminal cancel returns 409', async () => {
    const app = makeTestApp(true);

    const res = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({
        name: 'cancel-mid-svc',
        templateId: fastApiTemplateId,
      });
    const { workflowId } = res.body;

    await claimNext('worker-cancel');

    const baseSteps = makeSteps();
    // Wrap validate step to trigger HTTP cancel while running
    const stepsWithCancel = baseSteps.map((st) =>
      st.key === 'validate'
        ? {
            ...st,
            run: async (ctx: Parameters<typeof st.run>[0]) => {
              await st.run(ctx);
              const cancelRes = await request(app)
                .post(`/api/workflows/${workflowId}/cancel`)
                .set('Authorization', 'Bearer dev-owner-token');
              expect(cancelRes.status).toBe(200);
              expect(cancelRes.body.cancelRequested).toBe(true);
            },
          }
        : st
    );

    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-cancel',
      steps: stepsWithCancel,
    });

    const wfRes = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(wfRes.body.status).toBe('cancelled');
    expect(wfRes.body.steps[0].status).toBe('succeeded');
    expect(wfRes.body.steps[1].status).toBe('skipped');
    expect(wfRes.body.steps[2].status).toBe('skipped');
    expect(wfRes.body.steps[3].status).toBe('skipped');

    // Terminal cancel -> 409
    const terminalCancel = await request(app)
      .post(`/api/workflows/${workflowId}/cancel`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(terminalCancel.status).toBe(409);
  });

  it('stale-run recovery in the middle of push_files resumes and succeeds cleanly', async () => {
    const app = makeTestApp(true);

    const res = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({
        name: 'stale-push-svc',
        templateId: fastApiTemplateId,
      });
    const { workflowId } = res.body;

    await claimNext('worker-stale-1');

    const baseSteps = makeSteps();
    // Simulate worker-stale-1 crashing/losing lock in the middle of push_files
    // after validate, generate, and create_repository actually succeeded
    const crashingSteps = baseSteps.map((st) =>
      st.key === 'push_files'
        ? {
            ...st,
            run: async () => {
              // Backdate lock and recover while push_files is running
              await db
                .update(workflowRuns)
                .set({ locked_at: sql`now() - interval '5 minutes'` })
                .where(eq(workflowRuns.id, workflowId));
              const recovered = await requeueStale(60000);
              expect(recovered).toBe(1);
            },
          }
        : st
    );

    // Worker 1 executes steps 1-3, then loses lock mid-push_files
    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-stale-1',
      steps: crashingSteps,
    });

    const stepRows = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflow_run_id, workflowId));
    expect(stepRows.find((s) => s.key === 'push_files')?.status).toBe('waiting');

    // Worker 2 claims and completes push_files without re-running succeeded steps
    await claimNext('worker-stale-2');
    await executeWorkflow({
      runId: workflowId,
      workerId: 'worker-stale-2',
      steps: baseSteps,
    });

    const finalWf = await request(app)
      .get(`/api/workflows/${workflowId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(finalWf.body.status).toBe('succeeded');
    expect(finalWf.body.attempts).toBe(2);
    expect(fakeGitHub.repos.size).toBe(1);
  });

  it('duplicate POST with the same name returns 409 and creates one workflow', async () => {
    const app = makeTestApp(true);

    const r1 = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ name: 'unique-svc', templateId: fastApiTemplateId });
    expect(r1.status).toBe(202);

    const r2 = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ name: 'unique-svc', templateId: fastApiTemplateId });
    expect(r2.status).toBe(409);

    const listRes = await request(app)
      .get(`/api/workflows?serviceId=${r1.body.serviceId}`)
      .set('Authorization', 'Bearer viewer-token');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
  });

  it('enforces permission matrix, 503 when GitHub not configured, 422 unavailable template, 429 active workflow limit, and 409 delete guard', async () => {
    // 503 when GitHub not configured
    const unconfiguredApp = makeTestApp(false);
    const res503 = await request(unconfiguredApp)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ name: 'no-gh-svc', templateId: fastApiTemplateId });
    expect(res503.status).toBe(503);
    expect(res503.body.error.code).toBe('GITHUB_NOT_CONFIGURED');

    const app = makeTestApp(true);

    // Viewer 403 on scaffold
    const viewerScaffold = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer viewer-token')
      .send({ name: 'viewer-svc', templateId: fastApiTemplateId });
    expect(viewerScaffold.status).toBe(403);

    // 422 on unavailable template
    const res422 = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ name: 'node-svc', templateId: nodeTemplateId });
    expect(res422.status).toBe(422);
    expect(res422.body.error.code).toBe('TEMPLATE_UNAVAILABLE');

    // Create 3 active workflows for dev-owner
    const wfs: Array<{ serviceId: string; workflowId: string }> = [];
    for (let i = 1; i <= 3; i++) {
      const r = await request(app)
        .post('/api/services/scaffold')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: `limit-svc-${i}`, templateId: fastApiTemplateId });
      expect(r.status).toBe(202);
      wfs.push(r.body);
    }

    // 4th active workflow -> 429 TOO_MANY_ACTIVE_WORKFLOWS
    const res429 = await request(app)
      .post('/api/services/scaffold')
      .set('Authorization', 'Bearer dev-owner-token')
      .send({ name: 'limit-svc-4', templateId: fastApiTemplateId });
    expect(res429.status).toBe(429);
    expect(res429.body.error.code).toBe('TOO_MANY_ACTIVE_WORKFLOWS');

    // DELETE while workflow is queued -> 409 WORKFLOW_IN_PROGRESS
    const del409 = await request(app)
      .delete(`/api/services/${wfs[0].serviceId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(del409.status).toBe(409);
    expect(del409.body.error.code).toBe('WORKFLOW_IN_PROGRESS');

    // Permission matrix on cancel & retry:
    // Viewer -> 403
    const viewerCancel = await request(app)
      .post(`/api/workflows/${wfs[0].workflowId}/cancel`)
      .set('Authorization', 'Bearer viewer-token');
    expect(viewerCancel.status).toBe(403);

    const viewerRetry = await request(app)
      .post(`/api/workflows/${wfs[0].workflowId}/retry`)
      .set('Authorization', 'Bearer viewer-token');
    expect(viewerRetry.status).toBe(403);

    // Different developer -> 403
    const otherDevCancel = await request(app)
      .post(`/api/workflows/${wfs[0].workflowId}/cancel`)
      .set('Authorization', 'Bearer other-dev-token');
    expect(otherDevCancel.status).toBe(403);

    const otherDevRetry = await request(app)
      .post(`/api/workflows/${wfs[0].workflowId}/retry`)
      .set('Authorization', 'Bearer other-dev-token');
    expect(otherDevRetry.status).toBe(403);

    // Dashboard summary includes activeWorkflows
    const dashRes = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', 'Bearer viewer-token');
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.activeWorkflows).toBe(3);

    // Cancel workflow 0, then DELETE service succeeds
    const cancelOk = await request(app)
      .post(`/api/workflows/${wfs[0].workflowId}/cancel`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(cancelOk.status).toBe(200);

    const delOk = await request(app)
      .delete(`/api/services/${wfs[0].serviceId}`)
      .set('Authorization', 'Bearer dev-owner-token');
    expect(delOk.status).toBe(204);
  });
});
