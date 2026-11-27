import { and, eq } from 'drizzle-orm';
import { PUBLISH_JOB_NAME } from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { ciRuns, deployments, environments } from '../../db/schema.js';
import { transitionDeployment } from '../../deployments/state-machine.js';
import type { K8sRunner } from '../../k8s/exec.js';
import {
  checkHttpHealth,
  deployHelmRelease,
  ensureDbSecret,
  ensureGhcrPullSecret,
  getClusterDeploymentInfo,
  getHelmReleaseStatus,
} from '../../k8s/helm.js';
import { allocateEnvironmentNodePort } from '../../k8s/nodeport.js';
import { parseGitHubRepoUrl } from '../../modules/ci/service.js';
import type { Step } from '../executor.js';

export const DEPLOY_STEP_DEFINITIONS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'validate', name: 'Validate deployment & check no-op' },
  { key: 'prepare_secrets', name: 'Prepare Kubernetes secrets & NodePort' },
  { key: 'helm_deploy', name: 'Deploy Helm release' },
  { key: 'verify_health', name: 'Verify cluster rollout & health' },
];

export interface DeployStepsDeps {
  getK8sRunner: () => K8sRunner | null;
  getGhcrCredentials: () => { username: string; token: string } | null;
  getExpectedOrg?: () => string | null;
  checkHttp?: typeof checkHttpHealth;
}

export function buildImageRef(
  org: string,
  repo: string,
  commitSha: string
): {
  repository: string;
  image: string;
} {
  const repository = `ghcr.io/${org.toLowerCase()}/${repo.toLowerCase()}`;
  return {
    repository,
    image: `${repository}:${commitSha}`,
  };
}

export function createDeploySteps(deps: DeployStepsDeps): Step[] {
  const httpHealth = deps.checkHttp ?? checkHttpHealth;

  return [
    {
      key: 'validate',
      name: DEPLOY_STEP_DEFINITIONS[0].name,
      run: async (ctx) => {
        if (!ctx.service) {
          throw new Error(`Service '${ctx.run.service_id}' not found`);
        }
        if (ctx.service.provisioning_status !== 'ready') {
          throw new Error(`Service '${ctx.service.slug}' is not ready for deployment`);
        }

        const deploymentId = String(ctx.input.deploymentId ?? '');
        const commitSha = String(ctx.input.commitSha ?? '').toLowerCase();
        const environmentName = String(ctx.input.environmentName ?? 'development');

        if (!deploymentId || !/^[0-9a-f]{40}$/.test(commitSha)) {
          throw new Error('Invalid deploy workflow input: missing deploymentId or commitSha');
        }

        const parsedRepo = parseGitHubRepoUrl(
          ctx.service.repository_url,
          deps.getExpectedOrg?.() ?? null
        );
        if (!parsedRepo) {
          throw new Error(`Service '${ctx.service.slug}' has no valid GitHub repository URL`);
        }

        // Verify CI run + Publish Image succeeded on main
        const matchingRuns = await db
          .select()
          .from(ciRuns)
          .where(
            and(
              eq(ciRuns.service_id, ctx.service.id),
              eq(ciRuns.head_sha, commitSha),
              eq(ciRuns.head_branch, 'main'),
              eq(ciRuns.status, 'completed'),
              eq(ciRuns.conclusion, 'success')
            )
          );

        const verified = matchingRuns.some(
          (r) =>
            Array.isArray(r.jobs) &&
            r.jobs.some((j) => j.name === PUBLISH_JOB_NAME && j.conclusion === 'success')
        );
        if (!verified) {
          throw new Error(
            `Commit ${commitSha.slice(0, 7)} does not have a completed green CI run with '${PUBLISH_JOB_NAME}' on main`
          );
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
          throw new Error(`Environment '${environmentName}' not found for service`);
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

        const runner = deps.getK8sRunner();
        if (!runner) {
          throw new Error('Kubernetes worker kubeconfig is not configured');
        }

        const { repository, image } = buildImageRef(parsedRepo.org, parsedRepo.repo, commitSha);
        const releaseName = ctx.service.slug;

        // No-op check: same commit/image already deployed and healthy in cluster
        let isNoop = false;
        if (env.deployed_commit_sha === commitSha && env.deployed_image === image) {
          const helmStatus = await getHelmReleaseStatus(runner, releaseName);
          const clusterInfo = await getClusterDeploymentInfo(runner, ctx.service.slug);
          if (
            helmStatus.exists &&
            helmStatus.status === 'deployed' &&
            clusterInfo.exists &&
            clusterInfo.image === image &&
            clusterInfo.readyReplicas >= 1
          ) {
            isNoop = true;
            await ctx.saveResource('helmRevision', helmStatus.revision);
            await ctx.log(
              'info',
              `Commit ${commitSha.slice(0, 7)} is already deployed and healthy in cluster; treating as no-op`
            );
          }
        }

        await ctx.saveResource('deploymentId', dep.id);
        await ctx.saveResource('environmentId', env.id);
        await ctx.saveResource('releaseName', releaseName);
        await ctx.saveResource('imageRepository', repository);
        await ctx.saveResource('image', image);
        await ctx.saveResource('commitSha', commitSha);
        await ctx.saveResource('noop', isNoop);
      },
    },
    {
      key: 'prepare_secrets',
      name: DEPLOY_STEP_DEFINITIONS[1].name,
      run: async (ctx) => {
        if (ctx.resources.noop === true) {
          await ctx.log('info', 'No-op deployment: skipping secret & NodePort setup');
          return;
        }
        const runner = deps.getK8sRunner();
        if (!runner) {
          throw new Error('Kubernetes worker kubeconfig is not configured');
        }
        const ghcr = deps.getGhcrCredentials();
        if (!ghcr) {
          throw new Error(
            'GHCR_PULL_USERNAME and GHCR_PULL_TOKEN are required in apps/api/.env (see docs/ghcr-setup.md)'
          );
        }

        const environmentId = String(ctx.resources.environmentId);
        const { nodePort, url } = await allocateEnvironmentNodePort(environmentId);
        const slug = ctx.service!.slug;
        const ghcrSecretName = `${slug}-ghcr-pull`;
        const dbSecretName = `${slug}-db-secret`;

        await ctx.log('info', `Allocated NodePort ${nodePort} (${url})`);
        await ensureGhcrPullSecret(runner, ghcrSecretName, ghcr.username, ghcr.token);
        await ensureDbSecret(runner, dbSecretName, slug);
        await ctx.log('info', `Ensured secrets ${ghcrSecretName} and ${dbSecretName}`);

        await ctx.saveResource('nodePort', nodePort);
        await ctx.saveResource('url', url);
        await ctx.saveResource('ghcrSecretName', ghcrSecretName);
        await ctx.saveResource('dbSecretName', dbSecretName);
      },
    },
    {
      key: 'helm_deploy',
      name: DEPLOY_STEP_DEFINITIONS[2].name,
      run: async (ctx) => {
        if (ctx.resources.noop === true) {
          await ctx.log('info', 'No-op deployment: skipping helm upgrade');
          return;
        }
        const runner = deps.getK8sRunner();
        if (!runner) {
          throw new Error('Kubernetes worker kubeconfig is not configured');
        }

        const releaseName = String(ctx.resources.releaseName);
        const imageRepository = String(ctx.resources.imageRepository);
        const commitSha = String(ctx.resources.commitSha);
        const nodePort = Number(ctx.resources.nodePort);
        const ghcrSecretName = String(ctx.resources.ghcrSecretName);
        const dbSecretName = String(ctx.resources.dbSecretName);

        await ctx.log(
          'info',
          `Running helm upgrade --install ${releaseName} with image ${imageRepository}:${commitSha}`
        );

        const releaseStatus = await deployHelmRelease(runner, {
          releaseName,
          serviceSlug: ctx.service!.slug,
          imageRepository,
          imageTag: commitSha,
          imagePullSecretName: ghcrSecretName,
          dbSecretName,
          nodePort,
          commitSha,
        });

        await ctx.saveResource('helmRevision', releaseStatus.revision);
        await ctx.log(
          'info',
          `Helm release '${releaseName}' at revision ${releaseStatus.revision ?? 'unknown'} (${releaseStatus.status ?? 'unknown'})`
        );
      },
    },
    {
      key: 'verify_health',
      name: DEPLOY_STEP_DEFINITIONS[3].name,
      run: async (ctx) => {
        const deploymentId = String(ctx.resources.deploymentId);
        const environmentId = String(ctx.resources.environmentId);
        const commitSha = String(ctx.resources.commitSha);
        const image = String(ctx.resources.image);
        const helmRevision =
          typeof ctx.resources.helmRevision === 'number' ? ctx.resources.helmRevision : null;

        if (ctx.resources.noop === true) {
          await transitionDeployment(db, deploymentId, 'in_progress', 'succeeded', {
            completed_at: new Date(),
            helm_revision: helmRevision,
          });
          await ctx.log('info', 'No-op deployment marked succeeded');
          return;
        }

        const runner = deps.getK8sRunner();
        if (!runner) {
          throw new Error('Kubernetes worker kubeconfig is not configured');
        }

        const clusterInfo = await getClusterDeploymentInfo(runner, ctx.service!.slug);
        if (!clusterInfo.exists || clusterInfo.readyReplicas < 1) {
          throw new Error(
            `Deployment '${ctx.service!.slug}' is not ready in cluster (readyReplicas=${clusterInfo.readyReplicas})`
          );
        }
        if (clusterInfo.image !== image) {
          throw new Error(
            `Cluster image mismatch: expected '${image}', got '${clusterInfo.image ?? 'none'}'`
          );
        }

        const url = String(ctx.resources.url);
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

        await transitionDeployment(db, deploymentId, 'in_progress', 'succeeded', {
          completed_at: now,
          helm_revision: helmRevision,
        });

        await ctx.log(
          'info',
          `Verified ${ctx.service!.slug} healthy at ${url} with commit ${commitSha.slice(0, 7)}`
        );
      },
    },
  ];
}
