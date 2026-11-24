import { eq, and, sql } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { workflowRuns, workflowSteps, workflowLogs, services } from '../db/schema.js';
import {
  assertRunTransition,
  transitionRun,
  transitionStep,
  TransitionConflictError,
  LostLockError,
  WorkflowTerminalError,
} from './state-machine.js';
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
 * Updates locked_at only WHERE id = ? AND locked_by = workerId AND status = 'running'
 * and returns a boolean.
 */
export async function heartbeat(runId: string, workerId: string): Promise<boolean> {
  const result = await db
    .update(workflowRuns)
    .set({ locked_at: sql`now()` })
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
 * Requeue stale workflow runs in a single transaction:
 * Stale = status running and locked_at older than WORKER_STALE_MS.
 * Guarded update WHERE id = ? AND status = 'running' AND locked_at < now() - interval.
 * Running steps go back to waiting through transitionStep.
 * Writes the warn log row.
 */
export async function requeueStale(olderThanMs?: number): Promise<number> {
  const env = getEnv();
  const thresholdMs = olderThanMs ?? env.WORKER_STALE_MS;

  return await db.transaction(async (tx) => {
    const staleRuns = await tx.query.workflowRuns.findMany({
      where: and(
        eq(workflowRuns.status, 'running'),
        sql`locked_at < now() - (${thresholdMs} * interval '1 millisecond')`
      ),
      with: {
        steps: true,
      },
    });

    let recoveredCount = 0;

    for (const run of staleRuns) {
      try {
        await transitionRun(
          tx,
          run.id,
          'running',
          'queued',
          {
            locked_at: null,
            locked_by: null,
          },
          { staleBefore: thresholdMs }
        );

        // Running steps go back to waiting through transitionStep
        for (const step of run.steps) {
          if (step.status === 'running') {
            await transitionStep(tx, step.id, 'running', 'waiting', {
              started_at: null,
            });
          }
        }

        // Write warning log
        await tx.insert(workflowLogs).values({
          workflow_run_id: run.id,
          level: 'warn',
          message: `Workflow run was recovered from stale lock (${run.locked_by || 'unknown worker'}) and requeued`,
        });

        recoveredCount++;
      } catch (err) {
        if (err instanceof TransitionConflictError || err instanceof LostLockError) {
          // Another worker heartbeated or claimed; skip cleanly
          continue;
        }
        throw err;
      }
    }

    return recoveredCount;
  });
}

/**
 * Request cancellation of a workflow run:
 * In requestCancel, load the run inside the transaction with FOR UPDATE.
 * For a queued run, use transitionRun queued -> cancelled; if it changed zero rows
 * because a worker just claimed it, fall back to setting cancel_requested = true on the running run.
 * Terminal runs return a typed error the API can map to 409 (WorkflowTerminalError).
 */
export async function requestCancel(runId: string) {
  return await db.transaction(async (tx) => {
    const result = await tx.execute(
      sql`SELECT * FROM workflow_runs WHERE id = ${runId} FOR UPDATE`
    );
    const run = result.rows[0];

    if (!run) {
      throw new Error(`Workflow run '${runId}' not found`);
    }

    const currentStatus = run.status as string;
    if (
      currentStatus === 'succeeded' ||
      currentStatus === 'failed' ||
      currentStatus === 'cancelled'
    ) {
      throw new WorkflowTerminalError(runId, currentStatus);
    }

    if (currentStatus === 'queued') {
      try {
        await transitionRun(tx, run.id as string, 'queued', 'cancelled', {
          completed_at: sql`now()`,
          cancel_requested: true,
          locked_at: null,
          locked_by: null,
        });

        const steps = await tx.query.workflowSteps.findMany({
          where: eq(workflowSteps.workflow_run_id, run.id as string),
        });

        for (const step of steps) {
          if (step.status === 'waiting') {
            await transitionStep(tx, step.id, 'waiting', 'skipped');
          }
        }

        await tx.insert(workflowLogs).values({
          workflow_run_id: run.id as string,
          level: 'info',
          message: 'Workflow cancelled while queued',
        });

        return { cancelled: true, immediate: true };
      } catch (err) {
        if (err instanceof TransitionConflictError) {
          // Worker just claimed it; fall back to setting cancel_requested = true on the running run
          await tx
            .update(workflowRuns)
            .set({ cancel_requested: true })
            .where(eq(workflowRuns.id, run.id as string));

          await tx.insert(workflowLogs).values({
            workflow_run_id: run.id as string,
            level: 'info',
            message: 'Cancellation requested for running workflow',
          });

          return { cancelled: false, immediate: false, requested: true };
        }
        throw err;
      }
    }

    // Running workflow
    await tx
      .update(workflowRuns)
      .set({ cancel_requested: true })
      .where(eq(workflowRuns.id, run.id as string));

    await tx.insert(workflowLogs).values({
      workflow_run_id: run.id as string,
      level: 'info',
      message: 'Cancellation requested for running workflow',
    });

    return { cancelled: false, immediate: false, requested: true };
  });
}

/**
 * Retry a failed workflow run:
 * - Only failed runs can be retried.
 * - Guarded compare-and-set: transitionRun failed -> queued.
 * - Resets failed steps to waiting through transitionStep.
 * - For scaffold runs, resets service provisioning_status to 'provisioning'.
 */
export async function retry(runId: string) {
  return await db.transaction(async (tx) => {
    const result = await tx.execute(
      sql`SELECT * FROM workflow_runs WHERE id = ${runId} FOR UPDATE`
    );
    const run = result.rows[0];

    if (!run) {
      throw new Error(`Workflow run '${runId}' not found`);
    }

    if (run.status !== 'failed') {
      throw new TransitionConflictError('run', runId, 'failed', run.status as string);
    }

    // Guarded transition failed -> queued
    await transitionRun(tx, run.id as string, 'failed', 'queued', {
      locked_at: null,
      locked_by: null,
      completed_at: null,
      error_summary: null,
      cancel_requested: false,
    });

    const steps = await tx.query.workflowSteps.findMany({
      where: eq(workflowSteps.workflow_run_id, run.id as string),
    });

    // Reset failed steps to waiting through transitionStep
    for (const step of steps) {
      if (step.status === 'failed') {
        await transitionStep(tx, step.id, 'failed', 'waiting', {
          started_at: null,
          completed_at: null,
          error_summary: null,
        });
      }
    }

    // For scaffold runs, return service to provisioning
    if (run.type === 'scaffold' && run.service_id) {
      await tx
        .update(services)
        .set({ provisioning_status: 'provisioning' })
        .where(eq(services.id, run.service_id as string));
    }

    await tx.insert(workflowLogs).values({
      workflow_run_id: run.id as string,
      level: 'info',
      message: 'Workflow retry initiated',
    });

    return await tx.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, runId),
      with: { steps: true },
    });
  });
}
