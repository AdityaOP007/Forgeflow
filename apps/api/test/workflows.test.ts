import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/client.js';
import { services, workflowRuns, workflowSteps, workflowLogs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { testUsers } from './setup.js';
import {
  WORKFLOW_RUN_TRANSITIONS,
  WORKFLOW_STEP_TRANSITIONS,
  canTransitionRun,
  canTransitionStep,
  assertRunTransition,
  assertStepTransition,
  InvalidStateTransitionError,
} from '../src/workflows/state-machine.js';
import {
  enqueue,
  claimNext,
  heartbeat,
  requeueStale,
  requestCancel,
  retry,
} from '../src/workflows/queue.js';
import { executeWorkflow, type Step } from '../src/workflows/executor.js';
import { redactSecrets } from '../src/utils/redact.js';

describe('Workflow Engine — Checkpoint 2A', () => {
  let testServiceId: string;

  beforeEach(async () => {
    const [svc] = await db
      .insert(services)
      .values({
        name: `workflow-test-service-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        slug: `workflow-test-service-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        owner_id: testUsers.devOwner.id,
        provisioning_status: 'ready',
      })
      .returning();

    testServiceId = svc.id;
  });

  // ─── 1. State Machine ───────────────────────────────────────────────
  describe('State Machine Transitions', () => {
    it('allows every legal WorkflowRun transition', () => {
      // queued -> running | cancelled
      expect(canTransitionRun('queued', 'running')).toBe(true);
      expect(canTransitionRun('queued', 'cancelled')).toBe(true);
      assertRunTransition('queued', 'running');
      assertRunTransition('queued', 'cancelled');

      // running -> succeeded | failed | cancelled | queued
      expect(canTransitionRun('running', 'succeeded')).toBe(true);
      expect(canTransitionRun('running', 'failed')).toBe(true);
      expect(canTransitionRun('running', 'cancelled')).toBe(true);
      expect(canTransitionRun('running', 'queued')).toBe(true);

      // failed -> queued
      expect(canTransitionRun('failed', 'queued')).toBe(true);

      // terminal states have no transitions
      expect(WORKFLOW_RUN_TRANSITIONS.succeeded).toEqual([]);
      expect(WORKFLOW_RUN_TRANSITIONS.cancelled).toEqual([]);
    });

    it('rejects illegal WorkflowRun transitions', () => {
      expect(canTransitionRun('queued', 'succeeded')).toBe(false);
      expect(canTransitionRun('queued', 'failed')).toBe(false);
      expect(() => assertRunTransition('queued', 'succeeded')).toThrow(InvalidStateTransitionError);
      expect(() => assertRunTransition('succeeded', 'running')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => assertRunTransition('cancelled', 'running')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => assertRunTransition('failed', 'running')).toThrow(InvalidStateTransitionError);
    });

    it('allows every legal WorkflowStep transition', () => {
      // waiting -> running | skipped
      expect(canTransitionStep('waiting', 'running')).toBe(true);
      expect(canTransitionStep('waiting', 'skipped')).toBe(true);

      // running -> succeeded | failed | waiting
      expect(canTransitionStep('running', 'succeeded')).toBe(true);
      expect(canTransitionStep('running', 'failed')).toBe(true);
      expect(canTransitionStep('running', 'waiting')).toBe(true);

      // failed -> waiting
      expect(canTransitionStep('failed', 'waiting')).toBe(true);

      // terminal states
      expect(WORKFLOW_STEP_TRANSITIONS.succeeded).toEqual([]);
      expect(WORKFLOW_STEP_TRANSITIONS.skipped).toEqual([]);
    });

    it('rejects illegal WorkflowStep transitions', () => {
      expect(canTransitionStep('waiting', 'succeeded')).toBe(false);
      expect(canTransitionStep('waiting', 'failed')).toBe(false);
      expect(() => assertStepTransition('waiting', 'succeeded')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => assertStepTransition('succeeded', 'waiting')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => assertStepTransition('skipped', 'running')).toThrow(InvalidStateTransitionError);
    });
  });

  // ─── 2. Queue & Concurrency ─────────────────────────────────────────
  describe('Queue & Concurrency', () => {
    it('claims 20 queued runs with 5 concurrent claimers so every run is claimed exactly once', async () => {
      // Enqueue 20 runs
      const enqueuedIds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const { run } = await enqueue({
          serviceId: testServiceId,
          type: 'scaffold',
          steps: [
            { key: 'step_1', name: 'Step 1' },
            { key: 'step_2', name: 'Step 2' },
          ],
        });
        enqueuedIds.push(run.id);
      }

      expect(enqueuedIds).toHaveLength(20);

      // 5 concurrent workers claiming until queue is empty
      const claimedRuns: Array<{ id: string; workerId: string }> = [];

      async function runWorker(workerId: string) {
        while (true) {
          const claimed = await claimNext(workerId);
          if (!claimed) break;
          claimedRuns.push({ id: claimed.id, workerId });
        }
      }

      await Promise.all([
        runWorker('worker-1'),
        runWorker('worker-2'),
        runWorker('worker-3'),
        runWorker('worker-4'),
        runWorker('worker-5'),
      ]);

      // Exactly 20 claims
      expect(claimedRuns).toHaveLength(20);

      // Distinct IDs - no duplicate claims
      const claimedIds = new Set(claimedRuns.map((c) => c.id));
      expect(claimedIds.size).toBe(20);
      expect(Array.from(claimedIds).sort()).toEqual(enqueuedIds.sort());

      // Verify in DB that all are running, locked, and have attempts = 1
      const dbRuns = await db.select().from(workflowRuns);
      expect(dbRuns).toHaveLength(20);
      for (const r of dbRuns) {
        expect(r.status).toBe('running');
        expect(r.attempts).toBe(1);
        expect(r.locked_at).not.toBeNull();
        expect(r.locked_by).toMatch(/^worker-[1-5]$/);
      }
    });

    it('stale run is recovered and resumed without re-running succeeded steps', async () => {
      const { run } = await enqueue({
        serviceId: testServiceId,
        type: 'scaffold',
        steps: [
          { key: 'step_1', name: 'Validate' },
          { key: 'step_2', name: 'Generate' },
          { key: 'step_3', name: 'Deploy' },
        ],
      });

      // Claim run by worker-alpha
      const claimed = await claimNext('worker-alpha');
      expect(claimed).not.toBeNull();

      // Step 1 succeeded, Step 2 was running when worker crashed
      const steps = await db.query.workflowSteps.findMany({
        where: eq(workflowSteps.workflow_run_id, run.id),
      });

      const step1 = steps.find((s) => s.key === 'step_1')!;
      const step2 = steps.find((s) => s.key === 'step_2')!;

      await db
        .update(workflowSteps)
        .set({ status: 'succeeded', completed_at: new Date() })
        .where(eq(workflowSteps.id, step1.id));

      await db
        .update(workflowSteps)
        .set({ status: 'running', started_at: new Date() })
        .where(eq(workflowSteps.id, step2.id));

      // Simulate worker crash by backdating locked_at to 150 seconds ago (older than 120s stale threshold)
      const past = new Date(Date.now() - 150000);
      await db.update(workflowRuns).set({ locked_at: past }).where(eq(workflowRuns.id, run.id));

      // Recover stale runs
      const recovered = await requeueStale(120000);
      expect(recovered).toBe(1);

      // Verify run is queued and lock cleared
      const recoveredRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run.id),
      });
      expect(recoveredRun?.status).toBe('queued');
      expect(recoveredRun?.locked_at).toBeNull();
      expect(recoveredRun?.locked_by).toBeNull();

      // Verify step 2 was reset to waiting, step 1 remained succeeded
      const recoveredSteps = await db.query.workflowSteps.findMany({
        where: eq(workflowSteps.workflow_run_id, run.id),
      });
      expect(recoveredSteps.find((s) => s.key === 'step_1')?.status).toBe('succeeded');
      expect(recoveredSteps.find((s) => s.key === 'step_2')?.status).toBe('waiting');
      expect(recoveredSteps.find((s) => s.key === 'step_3')?.status).toBe('waiting');

      // Verify warning log entry was recorded
      const logs = await db.query.workflowLogs.findMany({
        where: eq(workflowLogs.workflow_run_id, run.id),
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn');
      expect(logs[0].message).toContain('recovered from stale lock');

      // Now claim and execute the recovered run with a new worker
      const reClaimed = await claimNext('worker-beta');
      expect(reClaimed).not.toBeNull();

      let step1Executed = false;
      let step2Executed = false;
      let step3Executed = false;

      const stepDefs: Step[] = [
        {
          key: 'step_1',
          name: 'Validate',
          run: async () => {
            step1Executed = true;
            throw new Error('Step 1 should not have been re-executed!');
          },
        },
        {
          key: 'step_2',
          name: 'Generate',
          run: async () => {
            step2Executed = true;
          },
        },
        {
          key: 'step_3',
          name: 'Deploy',
          run: async () => {
            step3Executed = true;
          },
        },
      ];

      await executeWorkflow({
        runId: run.id,
        workerId: 'worker-beta',
        steps: stepDefs,
      });

      // Verify step 1 was skipped and step 2, 3 executed
      expect(step1Executed).toBe(false);
      expect(step2Executed).toBe(true);
      expect(step3Executed).toBe(true);

      const finalRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run.id),
      });
      expect(finalRun?.status).toBe('succeeded');
    });

    it('heartbeat prevents recovery', async () => {
      const { run } = await enqueue({
        serviceId: testServiceId,
        type: 'scaffold',
        steps: [{ key: 'step_1', name: 'Step 1' }],
      });

      await claimNext('worker-heartbeat');

      // Set locked_at to 110 seconds ago
      const nearStale = new Date(Date.now() - 110000);
      await db
        .update(workflowRuns)
        .set({ locked_at: nearStale })
        .where(eq(workflowRuns.id, run.id));

      // Beat the heart to refresh locked_at
      const beatOk = await heartbeat(run.id, 'worker-heartbeat');
      expect(beatOk).toBe(true);

      // Attempt requeue with 120s threshold
      const recovered = await requeueStale(120000);
      expect(recovered).toBe(0);

      // Verify run remains running with lock intact
      const fresh = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run.id),
      });
      expect(fresh?.status).toBe('running');
      expect(fresh?.locked_by).toBe('worker-heartbeat');
    });

    it('cancel while queued cancels immediately and marks waiting steps skipped', async () => {
      const { run } = await enqueue({
        serviceId: testServiceId,
        type: 'scaffold',
        steps: [
          { key: 'step_1', name: 'Step 1' },
          { key: 'step_2', name: 'Step 2' },
        ],
      });

      const res = await requestCancel(run.id);
      expect(res).toEqual({ cancelled: true, immediate: true });

      const updatedRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run.id),
        with: { steps: true },
      });

      expect(updatedRun?.status).toBe('cancelled');
      expect(updatedRun?.cancel_requested).toBe(true);
      expect(updatedRun?.completed_at).not.toBeNull();
      for (const s of updatedRun!.steps) {
        expect(s.status).toBe('skipped');
      }
    });

    it('cancel requested while running stops before the next step and the rest are skipped', async () => {
      const { run } = await enqueue({
        serviceId: testServiceId,
        type: 'scaffold',
        steps: [
          { key: 'step_1', name: 'Step 1' },
          { key: 'step_2', name: 'Step 2' },
          { key: 'step_3', name: 'Step 3' },
        ],
      });

      await claimNext('worker-cancel-test');

      let step1Executed = false;
      let step2Executed = false;

      const stepDefs: Step[] = [
        {
          key: 'step_1',
          name: 'Step 1',
          run: async () => {
            step1Executed = true;
            // User cancels the run during step 1
            const cancelRes = await requestCancel(run.id);
            expect(cancelRes).toEqual({ cancelled: false, immediate: false, requested: true });
          },
        },
        {
          key: 'step_2',
          name: 'Step 2',
          run: async () => {
            step2Executed = true;
          },
        },
        {
          key: 'step_3',
          name: 'Step 3',
          run: async () => {},
        },
      ];

      await executeWorkflow({
        runId: run.id,
        workerId: 'worker-cancel-test',
        steps: stepDefs,
      });

      expect(step1Executed).toBe(true);
      expect(step2Executed).toBe(false);

      const finalRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run.id),
        with: { steps: true },
      });

      expect(finalRun?.status).toBe('cancelled');
      const step1 = finalRun?.steps.find((s) => s.key === 'step_1');
      const step2 = finalRun?.steps.find((s) => s.key === 'step_2');
      const step3 = finalRun?.steps.find((s) => s.key === 'step_3');

      expect(step1?.status).toBe('succeeded');
      expect(step2?.status).toBe('skipped');
      expect(step3?.status).toBe('skipped');
    });

    it('failed step makes run and service failed with redacted error summary', async () => {
      // Create scaffold service in provisioning state
      const [scaffoldService] = await db
        .insert(services)
        .values({
          name: 'scaffold-fail-service',
          slug: 'scaffold-fail-service',
          owner_id: testUsers.devOwner.id,
          provisioning_status: 'provisioning',
        })
        .returning();

      const { run } = await enqueue({
        serviceId: scaffoldService.id,
        type: 'scaffold',
        steps: [
          { key: 'step_1', name: 'Fail Step' },
          { key: 'step_2', name: 'Unreached Step' },
        ],
      });

      await claimNext('worker-fail-test');

      const stepDefs: Step[] = [
        {
          key: 'step_1',
          name: 'Fail Step',
          run: async () => {
            throw new Error(
              'Fatal error communicating with GitHub token ghs_1234567890123456789012345678901234'
            );
          },
        },
        {
          key: 'step_2',
          name: 'Unreached Step',
          run: async () => {},
        },
      ];

      await executeWorkflow({
        runId: run.id,
        workerId: 'worker-fail-test',
        steps: stepDefs,
      });

      const updatedRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run.id),
        with: { steps: true },
      });

      expect(updatedRun?.status).toBe('failed');
      expect(updatedRun?.error_summary).toContain('[REDACTED_TOKEN]');
      expect(updatedRun?.error_summary).not.toContain('ghs_');

      const failedStep = updatedRun?.steps.find((s) => s.key === 'step_1');
      const unreachedStep = updatedRun?.steps.find((s) => s.key === 'step_2');
      expect(failedStep?.status).toBe('failed');
      expect(failedStep?.error_summary).toContain('[REDACTED_TOKEN]');
      expect(unreachedStep?.status).toBe('waiting');

      // Verify service provisioning_status is set to failed
      const updatedService = await db.query.services.findFirst({
        where: eq(services.id, scaffoldService.id),
      });
      expect(updatedService?.provisioning_status).toBe('failed');
    });

    it('retry resumes from the failed step and sets service back to provisioning then ready', async () => {
      const [scaffoldService] = await db
        .insert(services)
        .values({
          name: 'scaffold-retry-service',
          slug: 'scaffold-retry-service',
          owner_id: testUsers.devOwner.id,
          provisioning_status: 'provisioning',
        })
        .returning();

      const { run } = await enqueue({
        serviceId: scaffoldService.id,
        type: 'scaffold',
        steps: [
          { key: 'step_1', name: 'Pass Step' },
          { key: 'step_2', name: 'Flaky Step' },
        ],
      });

      await claimNext('worker-retry-1');

      let shouldFail = true;

      const stepDefs: Step[] = [
        {
          key: 'step_1',
          name: 'Pass Step',
          run: async () => {},
        },
        {
          key: 'step_2',
          name: 'Flaky Step',
          run: async () => {
            if (shouldFail) {
              throw new Error('Temporary network glitch');
            }
          },
        },
      ];

      // Run 1: Step 2 fails
      await executeWorkflow({
        runId: run.id,
        workerId: 'worker-retry-1',
        steps: stepDefs,
      });

      const svcAfterFail = await db.query.services.findFirst({
        where: eq(services.id, scaffoldService.id),
      });
      expect(svcAfterFail?.provisioning_status).toBe('failed');

      // Retry the workflow
      await retry(run.id);

      const svcAfterRetry = await db.query.services.findFirst({
        where: eq(services.id, scaffoldService.id),
      });
      expect(svcAfterRetry?.provisioning_status).toBe('provisioning');

      // Run 2: Step 2 succeeds
      shouldFail = false;
      await claimNext('worker-retry-2');

      await executeWorkflow({
        runId: run.id,
        workerId: 'worker-retry-2',
        steps: stepDefs,
      });

      const finalRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run.id),
        with: { steps: true },
      });

      expect(finalRun?.status).toBe('succeeded');
      expect(finalRun?.steps.every((s) => s.status === 'succeeded')).toBe(true);

      const svcFinal = await db.query.services.findFirst({
        where: eq(services.id, scaffoldService.id),
      });
      expect(svcFinal?.provisioning_status).toBe('ready');
    });

    it('saveResource persists immediately to workflow_runs.resources', async () => {
      const { run } = await enqueue({
        serviceId: testServiceId,
        type: 'scaffold',
        steps: [{ key: 'step_1', name: 'Step 1' }],
      });

      await claimNext('worker-res-test');

      const stepDefs: Step[] = [
        {
          key: 'step_1',
          name: 'Step 1',
          run: async (ctx) => {
            await ctx.saveResource('repoUrl', 'https://github.com/org/repo');
            await ctx.saveResource('commitSha', 'abcdef123456');

            // Confirm it was written immediately to DB inside step execution
            const check = await db.query.workflowRuns.findFirst({
              where: eq(workflowRuns.id, run.id),
            });
            const res = check?.resources as Record<string, unknown>;
            expect(res.repoUrl).toBe('https://github.com/org/repo');
            expect(res.commitSha).toBe('abcdef123456');
          },
        },
      ];

      await executeWorkflow({
        runId: run.id,
        workerId: 'worker-res-test',
        steps: stepDefs,
      });

      const finalRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run.id),
      });
      const res = finalRun?.resources as Record<string, unknown>;
      expect(res.repoUrl).toBe('https://github.com/org/repo');
      expect(res.commitSha).toBe('abcdef123456');
    });
  });

  // ─── 3. Secrets Redaction ───────────────────────────────────────────
  describe('Secrets Redaction', () => {
    it('removes ghs_/ghp_/github_pat_ tokens, "Bearer <x>" and PEM blocks', () => {
      // GitHub App token
      const ghs = 'Error using token ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 in request';
      expect(redactSecrets(ghs)).toBe('Error using token [REDACTED_TOKEN] in request');

      // Personal access token
      const ghp = 'Auth error with ghp_0123456789abcdefghijklmnopqrstuvwxyz0123';
      expect(redactSecrets(ghp)).toBe('Auth error with [REDACTED_TOKEN]');

      // Fine-grained PAT
      const pat = 'Failed push with github_pat_11AABBCCDDEEFF00112233445566778899AABBCCDDEEFFGG';
      expect(redactSecrets(pat)).toBe('Failed push with [REDACTED_TOKEN]');

      // Bearer token
      const bearer = 'Failed authorization header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz';
      expect(redactSecrets(bearer)).toBe('Failed authorization header: Bearer [REDACTED_TOKEN]');

      // PEM private key
      const pem = `
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1+abcdefghijklmnopqrstuvwxyz0123456789+/=
-----END RSA PRIVATE KEY-----
`;
      expect(redactSecrets(pem).trim()).toBe('[REDACTED_PRIVATE_KEY]');

      // Combined secrets
      const combined = `Token ghs_123456789012345678901234567890 and Bearer secret-token-value!`;
      expect(redactSecrets(combined)).toBe('Token [REDACTED_TOKEN] and Bearer [REDACTED_TOKEN]!');
    });
  });
});
