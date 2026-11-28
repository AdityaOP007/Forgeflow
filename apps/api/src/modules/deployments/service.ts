import { and, count, desc, eq, inArray } from 'drizzle-orm';
import {
  PUBLISH_JOB_NAME,
  type DeployServiceInput,
  type DeployServiceResponse,
  type DeploymentItem,
  type DeploymentStatus,
  type ListDeploymentsQuery,
  type PaginatedResponse,
  type RollbackDeploymentInput,
  type UndeployServiceResponse,
} from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { ciRuns, deployments, environments, services } from '../../db/schema.js';
import { enqueue } from '../../workflows/queue.js';
import { DEPLOY_STEP_DEFINITIONS } from '../../workflows/steps/deploy.js';
import { UNDEPLOY_STEP_DEFINITIONS } from '../../workflows/steps/undeploy.js';
import { listDeployableCommits, parseGitHubRepoUrl } from '../ci/service.js';
import { writeAuditLog } from '../services/service.js';

function httpError(statusCode: number, code: string, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function assertServiceOwnerOrAdmin(
  svc: typeof services.$inferSelect,
  actorId: string,
  actorRole: string
): void {
  if (actorRole !== 'admin' && svc.owner_id !== actorId) {
    throw httpError(403, 'FORBIDDEN', 'Only the service owner or an admin can perform this action');
  }
}

export function serializeDeployment(row: typeof deployments.$inferSelect): DeploymentItem {
  return {
    id: row.id,
    serviceId: row.service_id,
    environmentId: row.environment_id,
    workflowRunId: row.workflow_run_id,
    commitSha: row.commit_sha,
    image: row.image,
    status: row.status as DeploymentStatus,
    rollbackOf: row.rollback_of,
    triggeredBy: row.triggered_by,
    helmRevision: row.helm_revision,
    errorSummary: row.error_summary,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

async function ensureServiceAndEnv(
  serviceId: string,
  envName: 'development',
  actorId: string,
  actorRole: string
) {
  const [svc] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
  if (!svc) {
    throw httpError(404, 'NOT_FOUND', 'Service not found');
  }
  assertServiceOwnerOrAdmin(svc, actorId, actorRole);

  if (svc.provisioning_status !== 'ready') {
    throw httpError(409, 'SERVICE_NOT_READY', 'Service must be ready before deploying');
  }

  let [env] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.service_id, serviceId), eq(environments.name, envName)))
    .limit(1);

  if (!env) {
    [env] = await db
      .insert(environments)
      .values({
        service_id: serviceId,
        name: envName,
        cluster: 'kind-forgeflow',
        namespace: 'forgeflow-dev',
        status: 'unknown',
      })
      .returning();
  }

  return { svc, env };
}

export async function listDeployments(
  query: ListDeploymentsQuery
): Promise<PaginatedResponse<DeploymentItem>> {
  const { page, pageSize, status, serviceId, environment } = query;
  const offset = (page - 1) * pageSize;

  const conditions = [];
  if (status) conditions.push(eq(deployments.status, status));
  if (serviceId) conditions.push(eq(deployments.service_id, serviceId));

  if (environment) {
    const matchingEnvs = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.name, environment));
    const envIds = matchingEnvs.map((e) => e.id);
    if (envIds.length === 0) {
      return { data: [], total: 0, page, pageSize, totalPages: 0 };
    }
    conditions.push(inArray(deployments.environment_id, envIds));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ value: total }] = await db
    .select({ value: count() })
    .from(deployments)
    .where(whereClause);

  const rows = await db
    .select()
    .from(deployments)
    .where(whereClause)
    .orderBy(desc(deployments.created_at))
    .limit(pageSize)
    .offset(offset);

  return {
    data: rows.map(serializeDeployment),
    total: Number(total),
    page,
    pageSize,
    totalPages: Math.ceil(Number(total) / pageSize),
  };
}

export async function getDeploymentById(id: string): Promise<DeploymentItem | null> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
  return row ? serializeDeployment(row) : null;
}

export async function listServiceDeployments(serviceId: string): Promise<DeploymentItem[]> {
  const [svc] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
  if (!svc) {
    throw httpError(404, 'NOT_FOUND', 'Service not found');
  }

  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.service_id, serviceId))
    .orderBy(desc(deployments.created_at))
    .limit(50);

  return rows.map(serializeDeployment);
}

async function resolveDeployableCommit(
  svc: typeof services.$inferSelect,
  requestedSha?: string
): Promise<string> {
  if (svc.template_version === '1.0.0') {
    throw httpError(
      409,
      'NO_PUBLISHED_IMAGE',
      'Service uses template version 1.0.0 which does not publish container images'
    );
  }

  if (!requestedSha) {
    const deployable = await listDeployableCommits(svc.id);
    if (deployable.length > 0) {
      return deployable[0].commitSha;
    }

    const completedGreen = await db
      .select({ id: ciRuns.id })
      .from(ciRuns)
      .where(
        and(
          eq(ciRuns.service_id, svc.id),
          eq(ciRuns.head_branch, 'main'),
          eq(ciRuns.status, 'completed'),
          eq(ciRuns.conclusion, 'success')
        )
      )
      .limit(1);

    if (completedGreen.length > 0) {
      throw httpError(
        409,
        'NO_PUBLISHED_IMAGE',
        `CI succeeded on main but no '${PUBLISH_JOB_NAME}' job succeeded`
      );
    }

    throw httpError(
      409,
      'CI_NOT_READY',
      'No completed green CI run found on main for this service'
    );
  }

  const sha = requestedSha.toLowerCase();
  const runs = await db
    .select()
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.service_id, svc.id),
        eq(ciRuns.head_sha, sha),
        eq(ciRuns.head_branch, 'main'),
        eq(ciRuns.status, 'completed'),
        eq(ciRuns.conclusion, 'success')
      )
    );

  if (runs.length === 0) {
    throw httpError(
      409,
      'CI_NOT_READY',
      `Commit ${sha.slice(0, 7)} does not have a completed green CI run on main`
    );
  }

  const hasPublished = runs.some(
    (r) =>
      Array.isArray(r.jobs) &&
      r.jobs.some((j) => j.name === PUBLISH_JOB_NAME && j.conclusion === 'success')
  );

  if (!hasPublished) {
    throw httpError(
      409,
      'NO_PUBLISHED_IMAGE',
      `Commit ${sha.slice(0, 7)} does not have a succeeded '${PUBLISH_JOB_NAME}' job`
    );
  }

  return sha;
}

export async function triggerDeploy(
  serviceId: string,
  input: DeployServiceInput,
  actorId: string,
  actorRole: string
): Promise<DeployServiceResponse> {
  const { svc, env } = await ensureServiceAndEnv(serviceId, input.environment, actorId, actorRole);
  const parsedRepo = parseGitHubRepoUrl(svc.repository_url);
  if (!parsedRepo) {
    throw httpError(400, 'MISSING_REPOSITORY', 'Service does not have a valid GitHub repository');
  }

  const commitSha = await resolveDeployableCommit(svc, input.commitSha);
  const image = `ghcr.io/${parsedRepo.org.toLowerCase()}/${parsedRepo.repo.toLowerCase()}:${commitSha}`;

  if (
    env.status === 'healthy' &&
    env.deployed_commit_sha === commitSha &&
    env.deployed_image === image
  ) {
    const [existing] = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.environment_id, env.id),
          eq(deployments.commit_sha, commitSha),
          eq(deployments.status, 'succeeded')
        )
      )
      .orderBy(desc(deployments.created_at))
      .limit(1);

    if (existing) {
      return {
        deploymentId: existing.id,
        workflowId: existing.workflow_run_id,
        status: 'succeeded',
        noop: true,
      };
    }
  }

  let dep: typeof deployments.$inferSelect;
  try {
    [dep] = await db
      .insert(deployments)
      .values({
        service_id: serviceId,
        environment_id: env.id,
        commit_sha: commitSha,
        image,
        status: 'queued',
        triggered_by: actorId,
      })
      .returning();
  } catch (err) {
    const pgCode =
      (err as { code?: string; cause?: { code?: string } })?.code ??
      (err as { cause?: { code?: string } })?.cause?.code;
    if (pgCode === '23505') {
      throw httpError(
        409,
        'DEPLOYMENT_IN_PROGRESS',
        `A deployment is already active for '${svc.name}' (${env.name})`
      );
    }
    throw err;
  }

  let run: Awaited<ReturnType<typeof enqueue>>['run'];
  try {
    ({ run } = await enqueue({
      serviceId,
      type: 'deploy',
      input: {
        deploymentId: dep.id,
        environment: input.environment,
        commitSha,
      },
      steps: [...DEPLOY_STEP_DEFINITIONS],
      createdBy: actorId,
    }));
  } catch (err) {
    await db.delete(deployments).where(eq(deployments.id, dep.id));
    throw err;
  }

  await db.update(deployments).set({ workflow_run_id: run.id }).where(eq(deployments.id, dep.id));

  await writeAuditLog(actorId, 'service.deploy', 'deployment', dep.id);

  return {
    deploymentId: dep.id,
    workflowId: run.id,
    status: 'queued',
  };
}

export async function triggerRollbackByDeploymentId(
  targetDeploymentId: string,
  input: RollbackDeploymentInput,
  actorId: string,
  actorRole: string
): Promise<DeployServiceResponse> {
  const [target] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, targetDeploymentId))
    .limit(1);

  if (!target) {
    throw httpError(404, 'NOT_FOUND', 'Target deployment not found');
  }

  const { svc, env } = await ensureServiceAndEnv(
    target.service_id,
    input.environment,
    actorId,
    actorRole
  );

  if (target.environment_id !== env.id) {
    throw httpError(
      400,
      'INVALID_ROLLBACK_TARGET',
      `Target deployment does not belong to environment '${input.environment}'`
    );
  }

  if (target.status !== 'succeeded' && target.status !== 'rolled_back') {
    throw httpError(
      409,
      'INVALID_ROLLBACK_TARGET',
      `Only a succeeded or rolled_back deployment can be rolled back to (current status: '${target.status}')`
    );
  }

  if (env.deployed_image && env.deployed_commit_sha === target.commit_sha) {
    throw httpError(
      409,
      'ROLLBACK_TARGET_ALREADY_RUNNING',
      `Commit ${target.commit_sha.slice(0, 7)} is already running in '${input.environment}'`
    );
  }

  const parsedRepo = parseGitHubRepoUrl(svc.repository_url);
  if (!parsedRepo) {
    throw httpError(400, 'MISSING_REPOSITORY', 'Service does not have a valid GitHub repository');
  }

  const image = `ghcr.io/${parsedRepo.org.toLowerCase()}/${parsedRepo.repo.toLowerCase()}:${target.commit_sha}`;

  let dep: typeof deployments.$inferSelect;
  try {
    [dep] = await db
      .insert(deployments)
      .values({
        service_id: svc.id,
        environment_id: env.id,
        commit_sha: target.commit_sha,
        image,
        status: 'queued',
        rollback_of: target.id,
        triggered_by: actorId,
      })
      .returning();
  } catch (err) {
    const pgCode =
      (err as { code?: string; cause?: { code?: string } })?.code ??
      (err as { cause?: { code?: string } })?.cause?.code;
    if (pgCode === '23505') {
      throw httpError(
        409,
        'DEPLOYMENT_IN_PROGRESS',
        `A deployment is already active for '${svc.name}' (${env.name})`
      );
    }
    throw err;
  }

  let run: Awaited<ReturnType<typeof enqueue>>['run'];
  try {
    ({ run } = await enqueue({
      serviceId: svc.id,
      type: 'deploy',
      input: {
        deploymentId: dep.id,
        rollbackOf: target.id,
        environment: input.environment,
        commitSha: target.commit_sha,
      },
      steps: [...DEPLOY_STEP_DEFINITIONS],
      createdBy: actorId,
    }));
  } catch (err) {
    await db.delete(deployments).where(eq(deployments.id, dep.id));
    throw err;
  }

  await db.update(deployments).set({ workflow_run_id: run.id }).where(eq(deployments.id, dep.id));

  await writeAuditLog(actorId, 'service.rollback', 'deployment', dep.id);

  return {
    deploymentId: dep.id,
    workflowId: run.id,
    status: 'queued',
  };
}

export async function triggerUndeploy(
  serviceId: string,
  environmentName: 'development',
  actorId: string,
  actorRole: string
): Promise<UndeployServiceResponse> {
  const { svc, env } = await ensureServiceAndEnv(serviceId, environmentName, actorId, actorRole);

  const active = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.environment_id, env.id),
        inArray(deployments.status, ['queued', 'in_progress'])
      )
    )
    .limit(1);

  if (active.length > 0) {
    throw httpError(
      409,
      'DEPLOYMENT_IN_PROGRESS',
      `Cannot undeploy '${svc.name}' while a deployment is queued or in progress`
    );
  }

  const { run } = await enqueue({
    serviceId,
    type: 'undeploy',
    input: {
      environmentName,
    },
    steps: [...UNDEPLOY_STEP_DEFINITIONS],
    createdBy: actorId,
  });

  await writeAuditLog(actorId, 'service.undeploy', 'service', serviceId);

  return {
    workflowId: run.id,
    status: 'queued',
  };
}
