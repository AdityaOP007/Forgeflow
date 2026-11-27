import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { deployments, environments } from '../../db/schema.js';
import { transitionDeployment } from '../../deployments/state-machine.js';
import type { K8sRunner } from '../../k8s/exec.js';
import {
  checkHttpHealth,
  deployHelmRelease,
  ensureDbSecret,
  ensureGhcrPullSecret,
  getClusterDeploymentInfo,
} from '../../k8s/helm.js';
import { allocateEnvironmentNodePort } from '../../k8s/nodeport.js';
import type { Step } from '../executor.js';
import { buildImageRef, type DeployStepsDeps } from './deploy.js';
import { parseGitHubRepoUrl } from '../../modules/ci/service.js';

export const ROLLBACK_STEP_DEFINITIONS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'validate', name: 'Validate rollback target' },
  { key: 'helm_rollback', name: 'Roll back Helm release' },
  { key: 'verify_health', name: 'Verify rolled-back deployment health' },
];

export function createRollbackSteps(deps: DeployStepsDeps): Step[] {
  const httpHealth = deps.checkHttp ?? checkHttpHealth;

  return [
    {
      key: 'validate',
      name: ROLLBACK_STEP_DEFINITIONS[0].name,
      run: async (ctx) => {
        if (!ctx.service) {
          throw new Error(`Service '${ctx.run.service_id}' not found`);
        }

        const deploymentId = String(ctx.input.deploymentId ?? '');
        const targetDeploymentId = String(ctx.input.targetDeploymentId ?? '');
        const environmentName = String(ctx.input.environmentName ?? 'development');

        if (!deploymentId || !targetDeploymentId) {
          throw new Error('Invalid rollback workflow input');
        }

        const parsedRepo = parseGitHubRepoUrl(
          ctx.service.repository_url,
          deps.getExpectedOrg?.() ?? null
        );
        if (!parsedRepo) {
          throw new Error(`Service '${ctx.service.slug}' has no valid GitHub repository URL`);
        }

        const [env] = await db
          .select()
          .from(environments)
          .where(
            and(
              eq(environments.service_id, ctx.service.id),
              eq(environments.name, environmentName as 'development')
            )
          )
          .limit(1);

        if (!env) {
          throw new Error(`Environment '${environmentName}' not found`);
        }

        const [target] = await db
          .select()
          .from(deployments)
          .where(
            and(eq(deployments.id, targetDeploymentId), eq(deployments.environment_id, env.id))
          )
          .limit(1);

        if (!target || (target.status !== 'succeeded' && target.status !== 'rolled_back')) {
          throw new Error(`Target deployment '${targetDeploymentId}' is not eligible for rollback`);
        }

        const [dep] = await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, deploymentId))
          .limit(1);

        if (!dep) {
          throw new Error(`Deployment '${deploymentId}' not found`);
        }

        if (dep.status === 'queued') {
          await transitionDeployment(db, dep.id, 'queued', 'in_progress', {
            started_at: new Date(),
          });
        }

        const { repository, image } = buildImageRef(
          parsedRepo.org,
          parsedRepo.repo,
          target.commit_sha
        );

        await ctx.saveResource('deploymentId', dep.id);
        await ctx.saveResource('targetDeploymentId', target.id);
        await ctx.saveResource('environmentId', env.id);
        await ctx.saveResource('releaseName', ctx.service.slug);
        await ctx.saveResource('imageRepository', repository);
        await ctx.saveResource('image', image);
        await ctx.saveResource('commitSha', target.commit_sha);
      },
    },
    {
      key: 'helm_rollback',
      name: ROLLBACK_STEP_DEFINITIONS[1].name,
      run: async (ctx) => {
        const runner: K8sRunner | null = deps.getK8sRunner();
        if (!runner) {
          throw new Error('Kubernetes worker kubeconfig is not configured');
        }
        const ghcr = deps.getGhcrCredentials();
        if (!ghcr) {
          throw new Error('GHCR_PULL_USERNAME and GHCR_PULL_TOKEN are required in apps/api/.env');
        }

        const environmentId = String(ctx.resources.environmentId);
        const { nodePort, url } = await allocateEnvironmentNodePort(environmentId);
        const slug = ctx.service!.slug;
        const ghcrSecretName = `${slug}-ghcr-pull`;
        const dbSecretName = `${slug}-db-secret`;

        await ensureGhcrPullSecret(runner, ghcrSecretName, ghcr.username, ghcr.token);
        await ensureDbSecret(runner, dbSecretName, slug);

        const releaseName = String(ctx.resources.releaseName);
        const imageRepository = String(ctx.resources.imageRepository);
        const commitSha = String(ctx.resources.commitSha);

        await ctx.log(
          'info',
          `Rolling back '${releaseName}' to commit ${commitSha.slice(0, 7)} (${imageRepository}:${commitSha})`
        );

        const releaseStatus = await deployHelmRelease(runner, {
          releaseName,
          serviceSlug: slug,
          imageRepository,
          imageTag: commitSha,
          imagePullSecretName: ghcrSecretName,
          dbSecretName,
          nodePort,
          commitSha,
        });

        await ctx.saveResource('nodePort', nodePort);
        await ctx.saveResource('url', url);
        await ctx.saveResource('helmRevision', releaseStatus.revision);
      },
    },
    {
      key: 'verify_health',
      name: ROLLBACK_STEP_DEFINITIONS[2].name,
      run: async (ctx) => {
        const runner = deps.getK8sRunner();
        if (!runner) {
          throw new Error('Kubernetes worker kubeconfig is not configured');
        }

        const deploymentId = String(ctx.resources.deploymentId);
        const environmentId = String(ctx.resources.environmentId);
        const commitSha = String(ctx.resources.commitSha);
        const image = String(ctx.resources.image);
        const url = String(ctx.resources.url);
        const helmRevision =
          typeof ctx.resources.helmRevision === 'number' ? ctx.resources.helmRevision : null;

        const clusterInfo = await getClusterDeploymentInfo(runner, ctx.service!.slug);
        if (!clusterInfo.exists || clusterInfo.readyReplicas < 1) {
          throw new Error(
            `Rolled-back deployment '${ctx.service!.slug}' is not ready (readyReplicas=${clusterInfo.readyReplicas})`
          );
        }
        if (clusterInfo.image !== image) {
          throw new Error(
            `Cluster image mismatch after rollback: expected '${image}', got '${clusterInfo.image ?? 'none'}'`
          );
        }

        const health = await httpHealth(url);
        if (!health.ok) {
          throw new Error(`HTTP health verification failed at ${url}: ${health.error}`);
        }

        const now = new Date();
        await db
          .update(environments)
          .set({
            cluster: 'kind-forgeflow',
            namespace: 'forgeflow-dev',
            deployed_version: commitSha.slice(0, 7),
            deployed_image: image,
            deployed_commit_sha: commitSha,
            observed_image: clusterInfo.image,
            observed_replicas: clusterInfo.replicas,
            observed_ready_replicas: clusterInfo.readyReplicas,
            last_observed_at: now,
            last_observed_error: null,
            status: 'healthy',
          })
          .where(eq(environments.id, environmentId));

        // Mark prior succeeded deployment(s) as rolled_back
        const prevSucceeded = await db
          .select({ id: deployments.id })
          .from(deployments)
          .where(
            and(
              eq(deployments.environment_id, environmentId),
              eq(deployments.status, 'succeeded'),
              ne(deployments.id, deploymentId)
            )
          );

        for (const prev of prevSucceeded) {
          await transitionDeployment(db, prev.id, 'succeeded', 'rolled_back');
        }

        await transitionDeployment(db, deploymentId, 'in_progress', 'succeeded', {
          completed_at: now,
          helm_revision: helmRevision,
        });

        await ctx.log('info', `Rollback to ${commitSha.slice(0, 7)} verified healthy at ${url}`);
      },
    },
  ];
}
