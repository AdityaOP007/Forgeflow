import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workflowRuns, workflowSteps, workflowLogs, services, deployments } from '../db/schema.js';
import { transitionRun, transitionStep, LostLockError } from './state-machine.js';
import { heartbeat } from './queue.js';
import { redactSecrets } from '../utils/redact.js';

export interface StepContext {
  run: typeof workflowRuns.$inferSelect;
  service: typeof services.$inferSelect | null;
  input: Record<string, unknown>;
  resources: Readonly<Record<string, unknown>>;
  saveResource: (key: string, value: unknown) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', message: string, stepKey?: string) => Promise<void>;
}

export interface Step {
  key: string;
  name: string;
  run: (ctx: StepContext) => Promise<void>;
}

export interface ExecuteOptions {
  runId: string;
  workerId: string;
  steps: Step[];
}

/**
 * Save a resource to workflow_runs.resources with workerId lock guard.
 * Throws LostLockError if the worker does not hold the lock or run is not running.
 */
export async function saveWorkflowResource(
  runId: string,
  workerId: string,
  key: string,
  value: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any = db
): Promise<Record<string, unknown>> {
  const run = await tx.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
  });

  if (!run) {
    throw new Error(`Workflow run '${runId}' not found`);
  }

  if (run.locked_by !== workerId || run.status !== 'running') {
    throw new LostLockError('run', runId, workerId, run.locked_by);
  }

  const updatedResources: Record<string, unknown> = {
    ...(run.resources as Record<string, unknown>),
    [key]: value,
  };

  const result = await tx
    .update(workflowRuns)
    .set({ resources: updatedResources })
    .where(
      and(
        eq(workflowRuns.id, runId),
        eq(workflowRuns.locked_by, workerId),
        eq(workflowRuns.status, 'running')
      )
    )
    .returning({ id: workflowRuns.id });

  if (result.length === 0) {
    const current = await tx.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, runId),
    });
    throw new LostLockError('run', runId, workerId, current?.locked_by);
  }

  return updatedResources;
}

export async function executeWorkflow(options: ExecuteOptions): Promise<void> {
  const { runId, workerId, steps: stepDefinitions } = options;

  const run = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
    with: {
      steps: true,
      service: true,
    },
  });

  if (!run) {
    throw new Error(`Workflow run '${runId}' not found`);
  }

  // Ensure worker owns the lock initially
  if (run.locked_by !== workerId || run.status !== 'running') {
    throw new LostLockError('run', runId, workerId, run.locked_by);
  }

  let lostLock = false;

  const handleLostLock = async (reason: string) => {
    if (lostLock) return;
    lostLock = true;
    console.warn(`[Worker ${workerId}] ${reason} on run ${runId}. Stopping executor.`);
    try {
      await db.insert(workflowLogs).values({
        workflow_run_id: run.id,
        level: 'warn',
        message: `Worker ${workerId} lost lock (${reason}). Execution stopped.`,
      });
    } catch {
      // Ignore log write error if DB is unreachable
    }
  };

  // Mutable copy of resources for in-memory access and updates
  const resources: Record<string, unknown> = { ...(run.resources as Record<string, unknown>) };

  const saveResource = async (key: string, value: unknown) => {
    if (lostLock) {
      throw new LostLockError('run', run.id, workerId);
    }
    const updated = await saveWorkflowResource(run.id, workerId, key, value);
    Object.assign(resources, updated);
  };

  const writeLog = async (level: 'info' | 'warn' | 'error', message: string, stepKey?: string) => {
    if (lostLock) return;
    const redacted = redactSecrets(message);
    await db.insert(workflowLogs).values({
      workflow_run_id: run.id,
      step_key: stepKey || null,
      level,
      message: redacted,
    });
  };

  const stepMap = new Map(run.steps.map((s) => [s.key, s]));

  // Execute steps in the given order
  for (const stepDef of stepDefinitions) {
    if (lostLock) {
      return;
    }

    // Check if cancellation was requested before executing the step
    const freshRun = await db.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, run.id),
    });

    if (!freshRun || freshRun.locked_by !== workerId || freshRun.status !== 'running') {
      await handleLostLock('Lost lock before step execution');
      return;
    }

    if (freshRun.cancel_requested) {
      try {
        await db.transaction(async (tx) => {
          // Mark any remaining waiting steps as skipped
          const remainingSteps = await tx.query.workflowSteps.findMany({
            where: eq(workflowSteps.workflow_run_id, run.id),
          });

          for (const st of remainingSteps) {
            if (st.status === 'waiting') {
              await transitionStep(tx, st.id, 'waiting', 'skipped', {}, { workerId });
            }
          }

          await transitionRun(
            tx,
            run.id,
            'running',
            'cancelled',
            {
              completed_at: sql`now()`,
              locked_at: null,
              locked_by: null,
            },
            { workerId }
          );

          if (run.type === 'deploy' || run.type === 'rollback') {
            await tx
              .update(deployments)
              .set({ status: 'cancelled', completed_at: sql`now()` })
              .where(
                and(
                  eq(deployments.workflow_run_id, run.id),
                  inArray(deployments.status, ['queued', 'in_progress'])
                )
              );
          }

          await tx.insert(workflowLogs).values({
            workflow_run_id: run.id,
            level: 'info',
            message: 'Workflow execution cancelled per user request',
          });
        });
      } catch (cancelErr) {
        if (cancelErr instanceof LostLockError) {
          await handleLostLock('Lost lock while cancelling run');
        }
      }

      return;
    }

    const stepRow = stepMap.get(stepDef.key);
    if (!stepRow) {
      continue;
    }

    // SKIP steps already succeeded (critical for recovery and retry)
    if (stepRow.status === 'succeeded') {
      await writeLog('info', `Step '${stepDef.name}' already succeeded, skipping.`, stepDef.key);
      continue;
    }

    // Step state transition: waiting -> running with workerId guard
    try {
      await transitionStep(
        db,
        stepRow.id,
        'waiting',
        'running',
        { started_at: sql`now()` },
        { workerId }
      );
    } catch (stepStartErr) {
      if (stepStartErr instanceof LostLockError) {
        await handleLostLock('Lost lock while starting step');
        return;
      }
      throw stepStartErr;
    }

    // Start 15s heartbeat during step execution
    const heartbeatTimer = setInterval(async () => {
      try {
        const ok = await heartbeat(run.id, workerId);
        if (!ok) {
          await handleLostLock('Heartbeat failed');
        }
      } catch {
        // Heartbeat failure handled via return boolean
      }
    }, 15000);

    const ctx: StepContext = {
      run,
      service: run.service,
      input: run.input as Record<string, unknown>,
      resources,
      saveResource,
      log: (level, msg) => writeLog(level, msg, stepDef.key),
    };

    try {
      await stepDef.run(ctx);

      if (lostLock) {
        return;
      }

      // Step succeeded with workerId guard
      await transitionStep(
        db,
        stepRow.id,
        'running',
        'succeeded',
        { completed_at: sql`now()` },
        { workerId }
      );

      stepRow.status = 'succeeded';
    } catch (err: unknown) {
      if (err instanceof LostLockError || lostLock) {
        await handleLostLock('Lost lock during step execution');
        return;
      }

      const rawMessage = err instanceof Error ? err.message : String(err);
      const redacted = redactSecrets(rawMessage).slice(0, 2000);

      try {
        await db.transaction(async (tx) => {
          // 1. Step failed with workerId guard
          await transitionStep(
            tx,
            stepRow.id,
            'running',
            'failed',
            {
              completed_at: sql`now()`,
              error_summary: redacted,
            },
            { workerId }
          );

          // 2. For scaffold runs, mark the service as failed with workerId guard while run is still running & locked
          if (run.type === 'scaffold' && run.service_id) {
            const svcRes = await tx
              .update(services)
              .set({ provisioning_status: 'failed' })
              .where(
                and(
                  eq(services.id, run.service_id),
                  sql`EXISTS (SELECT 1 FROM workflow_runs WHERE workflow_runs.id = ${run.id} AND workflow_runs.locked_by = ${workerId} AND workflow_runs.status = 'running')`
                )
              )
              .returning({ id: services.id });

            if (svcRes.length === 0) {
              throw new LostLockError('run', run.id, workerId);
            }
          }

          // 3. Run failed with workerId guard (releases lock)
          await transitionRun(
            tx,
            run.id,
            'running',
            'failed',
            {
              completed_at: sql`now()`,
              error_summary: redacted,
              locked_at: null,
              locked_by: null,
            },
            { workerId }
          );

          if (run.type === 'deploy' || run.type === 'rollback') {
            await tx
              .update(deployments)
              .set({
                status: 'failed',
                error_summary: redacted,
                completed_at: sql`now()`,
              })
              .where(
                and(
                  eq(deployments.workflow_run_id, run.id),
                  inArray(deployments.status, ['queued', 'in_progress'])
                )
              );
          }

          await tx.insert(workflowLogs).values({
            workflow_run_id: run.id,
            step_key: stepDef.key,
            level: 'error',
            message: `Step '${stepDef.name}' failed: ${redacted}`,
          });
        });
      } catch (failErr) {
        if (failErr instanceof LostLockError) {
          await handleLostLock('Lost lock while handling failure');
          return;
        }
        throw failErr;
      }
      return;
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  if (lostLock) {
    return;
  }

  // All steps succeeded
  try {
    await db.transaction(async (tx) => {
      // 1. For scaffold runs, mark service as ready with workerId guard while run is still running & locked
      if (run.type === 'scaffold' && run.service_id) {
        const svcRes = await tx
          .update(services)
          .set({ provisioning_status: 'ready' })
          .where(
            and(
              eq(services.id, run.service_id),
              sql`EXISTS (SELECT 1 FROM workflow_runs WHERE workflow_runs.id = ${run.id} AND workflow_runs.locked_by = ${workerId} AND workflow_runs.status = 'running')`
            )
          )
          .returning({ id: services.id });

        if (svcRes.length === 0) {
          throw new LostLockError('run', run.id, workerId);
        }
      }

      // 2. Run succeeded with workerId guard (releases lock)
      await transitionRun(
        tx,
        run.id,
        'running',
        'succeeded',
        {
          completed_at: sql`now()`,
          locked_at: null,
          locked_by: null,
        },
        { workerId }
      );

      await tx.insert(workflowLogs).values({
        workflow_run_id: run.id,
        level: 'info',
        message: 'Workflow run completed successfully',
      });
    });
  } catch (succErr) {
    if (succErr instanceof LostLockError) {
      await handleLostLock('Lost lock while completing workflow');
      return;
    }
    throw succErr;
  }
}
