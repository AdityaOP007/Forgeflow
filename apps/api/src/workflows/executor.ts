import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workflowRuns, workflowSteps, workflowLogs, services } from '../db/schema.js';
import { assertRunTransition, assertStepTransition } from './state-machine.js';
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

  // Mutable copy of resources for in-memory access and updates
  const resources: Record<string, unknown> = { ...(run.resources as Record<string, unknown>) };

  const saveResource = async (key: string, value: unknown) => {
    resources[key] = value;
    await db.update(workflowRuns).set({ resources }).where(eq(workflowRuns.id, run.id));
  };

  const writeLog = async (level: 'info' | 'warn' | 'error', message: string, stepKey?: string) => {
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
    // Check if cancellation was requested before executing the step
    const freshRun = await db.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, run.id),
    });

    if (freshRun?.cancel_requested) {
      assertRunTransition('running', 'cancelled');

      await db.transaction(async (tx) => {
        // Mark any remaining waiting steps as skipped
        const remainingSteps = await tx.query.workflowSteps.findMany({
          where: eq(workflowSteps.workflow_run_id, run.id),
        });

        for (const st of remainingSteps) {
          if (st.status === 'waiting') {
            assertStepTransition('waiting', 'skipped');
            await tx
              .update(workflowSteps)
              .set({ status: 'skipped' })
              .where(eq(workflowSteps.id, st.id));
          }
        }

        await tx
          .update(workflowRuns)
          .set({
            status: 'cancelled',
            completed_at: new Date(),
            locked_at: null,
            locked_by: null,
          })
          .where(eq(workflowRuns.id, run.id));

        await tx.insert(workflowLogs).values({
          workflow_run_id: run.id,
          level: 'info',
          message: 'Workflow execution cancelled per user request',
        });
      });

      return;
    }

    const stepRow = stepMap.get(stepDef.key);
    if (!stepRow) {
      // If no matching DB step row, continue
      continue;
    }

    // SKIP steps already succeeded (critical for recovery and retry)
    if (stepRow.status === 'succeeded') {
      await writeLog('info', `Step '${stepDef.name}' already succeeded, skipping.`, stepDef.key);
      continue;
    }

    // Step state transition: waiting -> running
    assertStepTransition(stepRow.status, 'running');
    await db
      .update(workflowSteps)
      .set({
        status: 'running',
        started_at: new Date(),
      })
      .where(eq(workflowSteps.id, stepRow.id));

    // Start 15s heartbeat during step execution
    const heartbeatTimer = setInterval(async () => {
      try {
        await heartbeat(run.id, workerId);
      } catch {
        // Heartbeat failure ignored; executor will continue
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

      // Step succeeded
      assertStepTransition('running', 'succeeded');
      await db
        .update(workflowSteps)
        .set({
          status: 'succeeded',
          completed_at: new Date(),
        })
        .where(eq(workflowSteps.id, stepRow.id));

      stepRow.status = 'succeeded';
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const redacted = redactSecrets(rawMessage).slice(0, 2000);

      // Step failed
      assertStepTransition('running', 'failed');
      await db
        .update(workflowSteps)
        .set({
          status: 'failed',
          completed_at: new Date(),
          error_summary: redacted,
        })
        .where(eq(workflowSteps.id, stepRow.id));

      // Run failed
      assertRunTransition('running', 'failed');
      await db
        .update(workflowRuns)
        .set({
          status: 'failed',
          completed_at: new Date(),
          error_summary: redacted,
          locked_at: null,
          locked_by: null,
        })
        .where(eq(workflowRuns.id, run.id));

      // For scaffold runs, mark the service as failed
      if (run.type === 'scaffold' && run.service_id) {
        await db
          .update(services)
          .set({ provisioning_status: 'failed' })
          .where(eq(services.id, run.service_id));
      }

      await writeLog('error', `Step '${stepDef.name}' failed: ${redacted}`, stepDef.key);
      return;
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  // All steps succeeded
  assertRunTransition('running', 'succeeded');
  await db
    .update(workflowRuns)
    .set({
      status: 'succeeded',
      completed_at: new Date(),
      locked_at: null,
      locked_by: null,
    })
    .where(eq(workflowRuns.id, run.id));

  // For scaffold runs, mark service as ready
  if (run.type === 'scaffold' && run.service_id) {
    await db
      .update(services)
      .set({ provisioning_status: 'ready' })
      .where(eq(services.id, run.service_id));
  }

  await writeLog('info', 'Workflow run completed successfully');
}
