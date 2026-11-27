import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  PUBLISH_JOB_NAME,
  type DeployServiceInput,
  type DeployServiceResponse,
  type DeploymentItem,
  type DeploymentStatus,
  type RollbackServiceInput,
  type UndeployServiceInput,
  type UndeployServiceResponse,
} from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { ciRuns, deployments, environments, services } from '../../db/schema.js';
import { enqueue } from '../../workflows/queue.js';
import { DEPLOY_STEP_DEFINITIONS } from '../../workflows/steps/deploy.js';
import { ROLLBACK_STEP_DEFINITIONS } from '../../workflows/steps/rollback.js';
import { UNDEPLOY_STEP_DEFINITIONS } from '../../workflows/steps/undeploy.js';
import { parseGitHubRepoUrl } from '../ci/service.js';
import { writeAuditLog } from '../services/service.js';

function httpError(statusCode: number, code: string, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
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

async function ensureServiceAndEnv(serviceId: string, envName: 'development') {
  const [svc] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
  if (!svc) {
    throw httpError(404, 'NOT_FOUND', 'Service not found');
  }
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

export async function triggerDeploy(
  serviceId: string,
  input: DeployServiceInput,
  userId: string
): Promise<DeployServiceResponse> {
  const { svc, env } = await ensureServiceAndEnv(serviceId, input.environmentName);
  const parsedRepo = parseGitHubRepoUrl(svc.repository_url);
  if (!parsedRepo) {
    throw httpError(400, 'MISSING_REPOSITORY', 'Service does not have a valid GitHub repository');
  }

  const commitSha = input.commitSha.toLowerCase();

  // Verify commit is deployable (completed green CI on main with Publish Image)
  const matchingRuns = await db
    .select()
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.service_id, serviceId),
        eq(ciRuns.head_sha, commitSha),
        eq(ciRuns.head_branch, 'main'),
        eq(ciRuns.status, 'completed'),
        eq(ciRuns.conclusion, 'success')
      )
    );

  const isDeployable = matchingRuns.some(
    (r) =>
      Array.isArray(r.jobs) &&
      r.jobs.some((j) => j.name === PUBLISH_JOB_NAME && j.conclusion === 'success')
  );

  if (!isDeployable) {
    throw httpError(
      400,
      'COMMIT_NOT_DEPLOYABLE',
      `Commit ${commitSha.slice(0, 7)} does not have a completed green CI run with '${PUBLISH_JOB_NAME}' on main`
    );
  }

  const image = `ghcr.io/${parsedRepo.org.toLowerCase()}/${parsedRepo.repo.toLowerCase()}:${commitSha}`;

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
        triggered_by: userId,
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
        environmentName: input.environmentName,
        commitSha,
      },
      steps: [...DEPLOY_STEP_DEFINITIONS],
      createdBy: userId,
    }));
  } catch (err) {
    await db.delete(deployments).where(eq(deployments.id, dep.id));
    throw err;
  }

  await db.update(deployments).set({ workflow_run_id: run.id }).where(eq(deployments.id, dep.id));

  await writeAuditLog(userId, 'service.deploy', 'deployment', dep.id);

  return {
    deploymentId: dep.id,
    workflowId: run.id,
    status: 'queued',
  };
}

export async function triggerRollback(
  serviceId: string,
  input: RollbackServiceInput,
  userId: string
): Promise<DeployServiceResponse> {
  const { svc, env } = await ensureServiceAndEnv(serviceId, input.environmentName);
  const parsedRepo = parseGitHubRepoUrl(svc.repository_url);
  if (!parsedRepo) {
    throw httpError(400, 'MISSING_REPOSITORY', 'Service does not have a valid GitHub repository');
  }

  let target: typeof deployments.$inferSelect | undefined;
  if (input.targetDeploymentId) {
    const [found] = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.id, input.targetDeploymentId),
          eq(deployments.service_id, serviceId),
          eq(deployments.environment_id, env.id)
        )
      )
      .limit(1);
    target = found;
  } else {
    // Pick most recent prior succeeded/rolled_back deployment with a different commit_sha
    const candidates = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.environment_id, env.id),
          inArray(deployments.status, ['succeeded', 'rolled_back']),
          env.deployed_commit_sha ? ne(deployments.commit_sha, env.deployed_commit_sha) : undefined
        )
      )
      .orderBy(desc(deployments.created_at))
      .limit(1);
    target = candidates[0];
  }

  if (!target || (target.status !== 'succeeded' && target.status !== 'rolled_back')) {
    throw httpError(
      400,
      'NO_ROLLBACK_TARGET',
      'No eligible previous deployment found to roll back to'
    );
  }

  const image = `ghcr.io/${parsedRepo.org.toLowerCase()}/${parsedRepo.repo.toLowerCase()}:${target.commit_sha}`;

  let dep: typeof deployments.$inferSelect;
  try {
    [dep] = await db
      .insert(deployments)
      .values({
        service_id: serviceId,
        environment_id: env.id,
        commit_sha: target.commit_sha,
        image,
        status: 'queued',
        rollback_of: target.id,
        triggered_by: userId,
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
      type: 'rollback',
      input: {
        deploymentId: dep.id,
        targetDeploymentId: target.id,
        environmentName: input.environmentName,
      },
      steps: [...ROLLBACK_STEP_DEFINITIONS],
      createdBy: userId,
    }));
  } catch (err) {
    await db.delete(deployments).where(eq(deployments.id, dep.id));
    throw err;
  }

  await db.update(deployments).set({ workflow_run_id: run.id }).where(eq(deployments.id, dep.id));

  await writeAuditLog(userId, 'service.rollback', 'deployment', dep.id);

  return {
    deploymentId: dep.id,
    workflowId: run.id,
    status: 'queued',
  };
}

export async function triggerUndeploy(
  serviceId: string,
  input: UndeployServiceInput,
  userId: string
): Promise<UndeployServiceResponse> {
  const { svc, env } = await ensureServiceAndEnv(serviceId, input.environmentName);

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
      environmentName: input.environmentName,
    },
    steps: [...UNDEPLOY_STEP_DEFINITIONS],
    createdBy: userId,
  });

  await writeAuditLog(userId, 'service.undeploy', 'service', serviceId);

  return {
    workflowId: run.id,
    status: 'queued',
  };
}
