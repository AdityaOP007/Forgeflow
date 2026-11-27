import type { DeploymentStatus } from '@forgeflow/shared-types';
import { and, eq } from 'drizzle-orm';
import { deployments } from '../db/schema.js';
import type { db as dbClient } from '../db/client.js';

/**
 * Legal state transitions for Deployment:
 * - queued -> in_progress | cancelled
 * - in_progress -> succeeded | failed | cancelled
 * - succeeded -> rolled_back
 * - failed: terminal
 * - cancelled: terminal
 * - rolled_back: terminal
 */
export const DEPLOYMENT_TRANSITIONS: Readonly<
  Record<DeploymentStatus, readonly DeploymentStatus[]>
> = {
  queued: ['in_progress', 'cancelled'],
  in_progress: ['succeeded', 'failed', 'cancelled'],
  succeeded: ['rolled_back'],
  failed: [],
  cancelled: [],
  rolled_back: [],
};

export class InvalidDeploymentTransitionError extends Error {
  readonly fromStatus: DeploymentStatus;
  readonly toStatus: DeploymentStatus;

  constructor(fromStatus: DeploymentStatus, toStatus: DeploymentStatus) {
    super(`Invalid deployment transition from '${fromStatus}' to '${toStatus}'`);
    this.name = 'InvalidDeploymentTransitionError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export class DeploymentTransitionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
  readonly id: string;
  readonly expectedStatus: DeploymentStatus;
  readonly actualStatus: string;

  constructor(id: string, expectedStatus: DeploymentStatus, actualStatus: string) {
    super(
      `Conflict transitioning deployment '${id}': expected '${expectedStatus}', got '${actualStatus}'`
    );
    this.name = 'DeploymentTransitionConflictError';
    this.id = id;
    this.expectedStatus = expectedStatus;
    this.actualStatus = actualStatus;
  }
}

export function isLegalDeploymentTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return DEPLOYMENT_TRANSITIONS[from].includes(to);
}

export function assertDeploymentTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!isLegalDeploymentTransition(from, to)) {
    throw new InvalidDeploymentTransitionError(from, to);
  }
}

type DbExecutor = typeof dbClient;

export type DeploymentPatch = Partial<{
  helm_revision: number | null;
  error_summary: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}>;

/**
 * Compare-and-set transition on the deployments table.
 * Validates the transition against DEPLOYMENT_TRANSITIONS before updating.
 */
export async function transitionDeployment(
  db: DbExecutor,
  deploymentId: string,
  fromStatus: DeploymentStatus,
  toStatus: DeploymentStatus,
  patch: DeploymentPatch = {}
): Promise<typeof deployments.$inferSelect> {
  assertDeploymentTransition(fromStatus, toStatus);

  const [updated] = await db
    .update(deployments)
    .set({
      ...patch,
      status: toStatus,
    })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.status, fromStatus)))
    .returning();

  if (updated) {
    return updated;
  }

  const [current] = await db
    .select({ status: deployments.status })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  throw new DeploymentTransitionConflictError(
    deploymentId,
    fromStatus,
    current?.status ?? 'not_found'
  );
}
