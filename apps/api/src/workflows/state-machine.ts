import type { WorkflowStatus, WorkflowStepStatus } from '@forgeflow/shared-types';

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
