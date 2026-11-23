import { eq, and, lt } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { workflowRuns, workflowSteps, workflowLogs, services } from '../db/schema.js';
import { assertRunTransition, assertStepTransition } from './state-machine.js';
import { getEnv } from '../config/env.js';

export interface EnqueueStepInput {
  key: string;
  name: string;
}

export interface EnqueueOptions {
  serviceId: string;
  type: string;
  input?: Record<string, unknown>;
  createdBy?: string | null;
  steps: EnqueueStepInput[];
}

/**
 * Enqueue a new workflow run and its initial steps in status 'waiting'.
 * Can be executed inside an existing transaction by passing `tx`.
 */
export async function enqueue(
  options: EnqueueOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any = db
) {
  const [run] = await tx
    .insert(workflowRuns)
    .values({
      service_id: options.serviceId,
      type: options.type,
      status: 'queued',
      input: options.input || {},
      resources: {},
      attempts: 0,
      cancel_requested: false,
      created_by: options.createdBy || null,
    })
    .returning();

  const stepsToInsert = options.steps.map((step, idx) => ({
    workflow_run_id: run.id,
    key: step.key,
    name: step.name,
    position: idx,
    status: 'waiting' as const,
  }));

  const steps =
    stepsToInsert.length > 0
      ? await tx.insert(workflowSteps).values(stepsToInsert).returning()
      : [];

  return { run, steps };
}

/**
 * Claim the next queued workflow run using FOR UPDATE SKIP LOCKED.
 * Increments attempts, sets locked_at/locked_by, and sets started_at on first claim.
 */
export async function claimNext(workerId: string) {
  const query = `
    UPDATE workflow_runs
    SET status = 'running',
        locked_at = now(),
        locked_by = $1,
        attempts = attempts + 1,
        started_at = COALESCE(started_at, now())
    WHERE id = (
      SELECT id FROM workflow_runs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  `;

  const result = await pool.query(query, [workerId]);
  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  assertRunTransition('queued', 'running');
  return row;
}

/**
 * Update locked_at timestamp for a running workflow.
 */
export async function heartbeat(runId: string, workerId: string): Promise<boolean> {
  const result = await db
    .update(workflowRuns)
    .set({ locked_at: new Date() })
    .where(
      and(
        eq(workflowRuns.id, runId),
        eq(workflowRuns.locked_by, workerId),
        eq(workflowRuns.status, 'running')
      )
    )
    .returning({ id: workflowRuns.id });

  return result.length > 0;
}

/**
 * Requeue stale workflow runs:
 * Stale = status running and locked_at older than WORKER_STALE_MS.
 * Sets the run back to queued, clears the lock, resets running steps to waiting,
 * and writes a warn log line.
 */
export async function requeueStale(olderThanMs?: number): Promise<number> {
  const env = getEnv();
  const thresholdMs = olderThanMs ?? env.WORKER_STALE_MS;
  const staleThreshold = new Date(Date.now() - thresholdMs);

  const staleRuns = await db.query.workflowRuns.findMany({
    where: and(eq(workflowRuns.status, 'running'), lt(workflowRuns.locked_at, staleThreshold)),
    with: {
      steps: true,
    },
  });

  let recoveredCount = 0;

  for (const run of staleRuns) {
    assertRunTransition('running', 'queued');

    await db.transaction(async (tx) => {
      // Requeue the run
      await tx
        .update(workflowRuns)
        .set({
          status: 'queued',
          locked_at: null,
          locked_by: null,
        })
        .where(eq(workflowRuns.id, run.id));

      // Reset any steps that were in running state back to waiting
      for (const step of run.steps) {
        if (step.status === 'running') {
          assertStepTransition('running', 'waiting');
          await tx
            .update(workflowSteps)
            .set({
              status: 'waiting',
              started_at: null,
            })
            .where(eq(workflowSteps.id, step.id));
        }
      }

      // Write warning log
      await tx.insert(workflowLogs).values({
        workflow_run_id: run.id,
        level: 'warn',
        message: `Workflow run was recovered from stale lock (${run.locked_by || 'unknown worker'}) and requeued`,
      });
    });

    recoveredCount++;
  }

  return recoveredCount;
}

/**
 * Request cancellation of a workflow run:
 * - If queued: cancelled immediately, waiting steps marked skipped.
 * - If running: sets cancel_requested = true.
 * - If terminal: throws error.
 */
export async function requestCancel(runId: string) {
  const run = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
    with: { steps: true },
  });

  if (!run) {
    throw new Error(`Workflow run '${runId}' not found`);
  }

  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
    throw new Error(`Cannot cancel terminal workflow run (status: ${run.status})`);
  }

  if (run.status === 'queued') {
    assertRunTransition('queued', 'cancelled');

    await db.transaction(async (tx) => {
      await tx
        .update(workflowRuns)
        .set({
          status: 'cancelled',
          completed_at: new Date(),
          cancel_requested: true,
        })
        .where(eq(workflowRuns.id, run.id));

      for (const step of run.steps) {
        if (step.status === 'waiting') {
          assertStepTransition('waiting', 'skipped');
          await tx
            .update(workflowSteps)
            .set({ status: 'skipped' })
            .where(eq(workflowSteps.id, step.id));
        }
      }

      await tx.insert(workflowLogs).values({
        workflow_run_id: run.id,
        level: 'info',
        message: 'Workflow cancelled while queued',
      });
    });

    return { cancelled: true, immediate: true };
  }

  // Running workflow
  await db.update(workflowRuns).set({ cancel_requested: true }).where(eq(workflowRuns.id, run.id));

  await db.insert(workflowLogs).values({
    workflow_run_id: run.id,
    level: 'info',
    message: 'Cancellation requested for running workflow',
  });

  return { cancelled: false, immediate: false, requested: true };
}

/**
 * Retry a failed workflow run:
 * - Only failed runs can be retried.
 * - Resets failed and skipped steps to waiting.
 * - Clears the lock and sets status back to queued.
 * - For scaffold runs, resets service provisioning_status to 'provisioning'.
 */
export async function retry(runId: string) {
  const run = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
    with: { steps: true },
  });

  if (!run) {
    throw new Error(`Workflow run '${runId}' not found`);
  }

  if (run.status !== 'failed') {
    throw new Error(`Cannot retry workflow run that is not failed (status: ${run.status})`);
  }

  assertRunTransition('failed', 'queued');

  await db.transaction(async (tx) => {
    // Reset run
    await tx
      .update(workflowRuns)
      .set({
        status: 'queued',
        locked_at: null,
        locked_by: null,
        completed_at: null,
        error_summary: null,
        cancel_requested: false,
      })
      .where(eq(workflowRuns.id, run.id));

    // Reset failed and skipped steps to waiting
    for (const step of run.steps) {
      if (step.status === 'failed' || step.status === 'skipped') {
        if (step.status === 'failed') {
          assertStepTransition('failed', 'waiting');
        } else {
          // skipped -> waiting on retry
          assertStepTransition('waiting', 'running'); // verification
        }
        await tx
          .update(workflowSteps)
          .set({
            status: 'waiting',
            started_at: null,
            completed_at: null,
            error_summary: null,
          })
          .where(eq(workflowSteps.id, step.id));
      }
    }

    // For scaffold runs, return service to provisioning
    if (run.type === 'scaffold' && run.service_id) {
      await tx
        .update(services)
        .set({ provisioning_status: 'provisioning' })
        .where(eq(services.id, run.service_id));
    }

    await tx.insert(workflowLogs).values({
      workflow_run_id: run.id,
      level: 'info',
      message: 'Workflow retry initiated',
    });
  });

  return db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
    with: { steps: true },
  });
}
