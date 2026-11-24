import type { WorkflowStatus, WorkflowStepStatus } from '@forgeflow/shared-types';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { workflowRuns, workflowSteps } from '../db/schema.js';

/**
 * Valid transitions for WorkflowRun:
 * - queued -> running | cancelled
 * - running -> succeeded | failed | cancelled | queued (stale recovery)
 * - failed -> queued (retry)
 * - succeeded: terminal
 * - cancelled: terminal
 */
export const WORKFLOW_RUN_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> =
  {
    queued: ['running', 'cancelled'],
    running: ['succeeded', 'failed', 'cancelled', 'queued'],
    failed: ['queued'],
    succeeded: [],
    cancelled: [],
  };

/**
 * Valid transitions for WorkflowStep:
 * - waiting -> running | skipped
 * - running -> succeeded | failed | waiting (recovery)
 * - failed -> waiting (retry)
 * - succeeded: terminal
 * - skipped: terminal
 */
export const WORKFLOW_STEP_TRANSITIONS: Readonly<
  Record<WorkflowStepStatus, readonly WorkflowStepStatus[]>
> = {
  waiting: ['running', 'skipped'],
  running: ['succeeded', 'failed', 'waiting'],
  failed: ['waiting'],
  succeeded: [],
  skipped: [],
};

export class InvalidStateTransitionError extends Error {
  readonly entityType: 'run' | 'step';
  readonly fromStatus: string;
  readonly toStatus: string;

  constructor(entityType: 'run' | 'step', fromStatus: string, toStatus: string) {
    super(`Invalid ${entityType} transition from '${fromStatus}' to '${toStatus}'`);
    this.name = 'InvalidStateTransitionError';
    this.entityType = entityType;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export class TransitionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
  readonly entityType: 'run' | 'step';
  readonly id: string;
  readonly expectedStatus: string;
  readonly actualStatus: string;

  constructor(
    entityType: 'run' | 'step',
    id: string,
    expectedStatus: string,
    actualStatus: string
  ) {
    super(
      `Conflict transitioning ${entityType} '${id}': expected '${expectedStatus}', got '${actualStatus}'`
    );
    this.name = 'TransitionConflictError';
    this.entityType = entityType;
    this.id = id;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
  }
}

export class LostLockError extends Error {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
  readonly entityType: 'run' | 'step';
  readonly id: string;
  readonly workerId: string;
  readonly currentLockedBy?: string | null;

  constructor(
    entityType: 'run' | 'step',
    id: string,
    workerId: string,
    currentLockedBy?: string | null
  ) {
    super(
      `Worker '${workerId}' lost lock on ${entityType} '${id}' (current locked_by: '${currentLockedBy ?? 'none'}')`
    );
    this.name = 'LostLockError';
    this.entityType = entityType;
    this.id = id;
    this.workerId = workerId;
    this.currentLockedBy = currentLockedBy;
  }
}

export class WorkflowTerminalError extends Error {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
  readonly runId: string;
  readonly status: string;

  constructor(runId: string, status: string) {
    super(`Cannot cancel workflow run '${runId}' because it is in terminal status '${status}'`);
    this.name = 'WorkflowTerminalError';
    this.runId = runId;
    this.status = status;
  }
}

export function canTransitionRun(from: WorkflowStatus, to: WorkflowStatus): boolean {
  const allowed = WORKFLOW_RUN_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function assertRunTransition(from: WorkflowStatus, to: WorkflowStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new InvalidStateTransitionError('run', from, to);
  }
}

export function canTransitionStep(from: WorkflowStepStatus, to: WorkflowStepStatus): boolean {
  const allowed = WORKFLOW_STEP_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function assertStepTransition(from: WorkflowStepStatus, to: WorkflowStepStatus): void {
  if (!canTransitionStep(from, to)) {
    throw new InvalidStateTransitionError('step', from, to);
  }
}

export function assertTransition(
  entityType: 'run' | 'step',
  fromStatus: string,
  toStatus: string
): void {
  if (entityType === 'run') {
    assertRunTransition(fromStatus as WorkflowStatus, toStatus as WorkflowStatus);
  } else {
    assertStepTransition(fromStatus as WorkflowStepStatus, toStatus as WorkflowStepStatus);
  }
}

export interface TransitionRunOptions {
  workerId?: string;
  staleBefore?: number | SQL;
}

/**
 * Compare-and-set transition helper for workflow_runs.
 * Validates transition, runs UPDATE ... WHERE id = ? AND status = <from> (+ optional workerId/staleBefore guards),
 * and throws typed TransitionConflictError or LostLockError if zero rows changed.
 */
export async function transitionRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  runId: string,
  from: WorkflowStatus,
  to: WorkflowStatus,
  extra?: Record<string, unknown>,
  opts?: TransitionRunOptions
) {
  assertRunTransition(from, to);

  const updateSet: Record<string, unknown> = {
    status: to,
    ...extra,
  };

  const conditions = [eq(workflowRuns.id, runId), eq(workflowRuns.status, from)];

  if (opts?.workerId !== undefined) {
    conditions.push(eq(workflowRuns.locked_by, opts.workerId));
  }
  if (opts?.staleBefore !== undefined) {
    if (typeof opts.staleBefore === 'number') {
      conditions.push(sql`locked_at < now() - (${opts.staleBefore} * interval '1 millisecond')`);
    } else {
      conditions.push(sql`locked_at < ${opts.staleBefore}`);
    }
  }

  const result = await tx
    .update(workflowRuns)
    .set(updateSet)
    .where(and(...conditions))
    .returning();

  if (result.length === 0) {
    const current = await tx.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, runId),
    });

    if (!current) {
      throw new Error(`Workflow run '${runId}' not found`);
    }

    if (opts?.workerId !== undefined && current.locked_by !== opts.workerId) {
      throw new LostLockError('run', runId, opts.workerId, current.locked_by);
    }

    if (current.status !== from) {
      throw new TransitionConflictError('run', runId, from, current.status);
    }

    if (opts?.staleBefore !== undefined) {
      const checkSql =
        typeof opts.staleBefore === 'number'
          ? sql`SELECT (locked_at < now() - (${opts.staleBefore} * interval '1 millisecond')) AS is_stale FROM workflow_runs WHERE id = ${runId}`
          : sql`SELECT (locked_at < ${opts.staleBefore}) AS is_stale FROM workflow_runs WHERE id = ${runId}`;
      const staleRes = await tx.execute(checkSql);
      if (!staleRes.rows[0]?.is_stale) {
        throw new TransitionConflictError('run', runId, from, `${current.status} (lock not stale)`);
      }
    }

    if (opts?.workerId !== undefined) {
      throw new LostLockError('run', runId, opts.workerId, current.locked_by);
    }

    throw new TransitionConflictError('run', runId, from, current.status);
  }

  return result[0];
}

export interface TransitionStepOptions {
  workerId?: string;
}

/**
 * Compare-and-set transition helper for workflow_steps.
 * Validates transition, runs UPDATE ... WHERE id = ? AND status = <from> (+ optional workerId guard on parent run),
 * and throws typed TransitionConflictError or LostLockError if zero rows changed.
 */
export async function transitionStep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  stepId: string,
  from: WorkflowStepStatus,
  to: WorkflowStepStatus,
  extra?: Record<string, unknown>,
  opts?: TransitionStepOptions
) {
  assertStepTransition(from, to);

  const updateSet: Record<string, unknown> = {
    status: to,
    ...extra,
  };

  const conditions = [eq(workflowSteps.id, stepId), eq(workflowSteps.status, from)];

  if (opts?.workerId !== undefined) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM workflow_runs 
        WHERE workflow_runs.id = ${workflowSteps.workflow_run_id} 
          AND workflow_runs.locked_by = ${opts.workerId}
      )`
    );
  }

  const result = await tx
    .update(workflowSteps)
    .set(updateSet)
    .where(and(...conditions))
    .returning();

  if (result.length === 0) {
    const currentStep = await tx.query.workflowSteps.findFirst({
      where: eq(workflowSteps.id, stepId),
      with: {
        workflowRun: true,
      },
    });

    if (!currentStep) {
      throw new Error(`Workflow step '${stepId}' not found`);
    }

    if (opts?.workerId !== undefined && currentStep.workflowRun?.locked_by !== opts.workerId) {
      throw new LostLockError('step', stepId, opts.workerId, currentStep.workflowRun?.locked_by);
    }

    if (currentStep.status !== from) {
      throw new TransitionConflictError('step', stepId, from, currentStep.status);
    }

    if (opts?.workerId !== undefined) {
      throw new LostLockError('step', stepId, opts.workerId, currentStep.workflowRun?.locked_by);
    }

    throw new TransitionConflictError('step', stepId, from, currentStep.status);
  }

  return result[0];
}
