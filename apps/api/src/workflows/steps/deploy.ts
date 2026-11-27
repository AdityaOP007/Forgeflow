import fs from 'fs';
import path from 'path';
import { and, eq, ne } from 'drizzle-orm';
import { PUBLISH_JOB_NAME } from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { ciRuns, deployments, environments } from '../../db/schema.js';
import { transitionDeployment } from '../../deployments/state-machine.js';
import type { GitHubClient } from '../../github/types.js';
import type { K8sRunner } from '../../k8s/exec.js';
import {
  checkHttpHealth,
  deployHelmRelease,
  ensureDbSecret,
  ensureGhcrPullSecret,
  getClusterDeploymentInfo,
  getHelmReleaseStatus,
  SERVICE_CHART_PATH,
} from '../../k8s/helm.js';
import { allocateEnvironmentNodePort } from '../../k8s/nodeport.js';
import {
  computeEnvironmentObservation,
  type K8sDeploymentItem,
  type K8sPodItem,
} from '../../k8s/reconciler.js';
import { parseGitHubRepoUrl } from '../../modules/ci/service.js';
import { redactSecrets } from '../../utils/redact.js';
import type { Step } from '../executor.js';

export const DEPLOY_STEP_DEFINITIONS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'preflight', name: 'Preflight checks & CI verification' },
  { key: 'prepare', name: 'Prepare Kubernetes secrets & NodePort' },
  { key: 'deploy', name: 'Deploy Helm release' },
  { key: 'verify', name: 'Verify cluster rollout & health' },
];

export interface DeployStepsDeps {
  getK8sRunner: () => K8sRunner | null;
  getGhcrCredentials: () => { username: string; token: string } | null;
  getGitHubClient?: () => GitHubClient | null;
  getExpectedOrg?: () => string | null;
  getChartPath?: () => string;
  getDeployTimeoutSeconds?: () => number;
  checkHttp?: typeof checkHttpHealth;
}

const IMAGE_REF_REGEX = /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+:[0-9a-f]{40}$/;

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

async function observeEnvironmentAfterFailure(
  runner: K8sRunner,
  environmentId: string,
  serviceSlug: string,
  deployedImage: string | null,
  hadPriorDeployment: boolean
): Promise<void> {
  try {
    const depRes = await runner.kubectl(['get', 'deployments', '-o', 'json']);
    const parsedDeps = JSON.parse(depRes.stdout) as { items?: K8sDeploymentItem[] };
    const deployment =
      (parsedDeps.items ?? []).find((d) => d.metadata?.name === serviceSlug) ?? null;

    let pods: K8sPodItem[] = [];
    try {
      const podRes = await runner.kubectl(['get', 'pods', '-o', 'json']);
      const parsedPods = JSON.parse(podRes.stdout) as { items?: K8sPodItem[] };
      pods = (parsedPods.items ?? []).filter(
        (p) =>
          p.metadata?.labels?.['app.kubernetes.io/instance'] === serviceSlug ||
          p.metadata?.labels?.['app.kubernetes.io/name'] === serviceSlug ||
          p.metadata?.name?.startsWith(`${serviceSlug}-`)
      );
    } catch {
      pods = [];
    }

    const obs = computeEnvironmentObservation({
      deployedImage,
      deployment,
      pods,
      clusterReachable: true,
    });

    await db
      .update(environments)
      .set({
        status: hadPriorDeployment ? obs.status : deployment ? obs.status : 'unknown',
        observed_image: obs.observedImage,
        observed_replicas: obs.observedReplicas,
        observed_ready_replicas: obs.observedReadyReplicas,
        last_observed_at: new Date(),
        last_observed_error: obs.lastObservedError,
        ...(hadPriorDeployment ? {} : { node_port: null, url: null }),
      })
      .where(eq(environments.id, environmentId));
  } catch {
    if (!hadPriorDeployment) {
      await db
        .update(environments)
        .set({ node_port: null, url: null })
        .where(eq(environments.id, environmentId));
    }
  }
}

export function createDeploySteps(deps: DeployStepsDeps): Step[] {
  const httpHealth = deps.checkHttp ?? checkHttpHealth;

  return [
    {
      key: 'preflight',
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
        const environmentName = String(
          ctx.input.environment ?? ctx.input.environmentName ?? 'development'
        );

        if (!deploymentId || !/^[0-9a-f]{40}$/.test(commitSha)) {
          throw new Error('Invalid deploy workflow input: missing deploymentId or commitSha');
        }

        // 1. Check cluster reachable
        const runner = deps.getK8sRunner();
        if (!runner) {
          throw new Error('Kubernetes worker kubeconfig is not configured');
        }
        try {
          await runner.kubectl(['version', '--output=json']);
        } catch (err) {
          throw new Error(
            `Kubernetes cluster is not reachable: ${redactSecrets(err instanceof Error ? err.message : String(err))}`
          );
        }

        // 2. Check chart present
        const chartPath = deps.getChartPath?.() ?? SERVICE_CHART_PATH;
        if (!fs.existsSync(path.join(chartPath, 'Chart.yaml'))) {
          throw new Error(`Helm chart not found at '${chartPath}'`);
        }

        // 3. Check GHCR_PULL_USERNAME and GHCR_PULL_TOKEN present (names only!)
        const ghcr = deps.getGhcrCredentials();
        if (!ghcr || !ghcr.username || !ghcr.token) {
          throw new Error(
            'Missing required environment variables: GHCR_PULL_USERNAME and GHCR_PULL_TOKEN (see docs/ghcr-setup.md)'
          );
        }

        // 4. Validate image reference
        const parsedRepo = parseGitHubRepoUrl(
          ctx.service.repository_url,
          deps.getExpectedOrg?.() ?? null
        );
        if (!parsedRepo) {
          throw new Error(`Service '${ctx.service.slug}' has no valid GitHub repository URL`);
        }
        const { repository, image } = buildImageRef(parsedRepo.org, parsedRepo.repo, commitSha);
        if (!IMAGE_REF_REGEX.test(image)) {
          throw new Error(`Invalid container image reference '${image}'`);
        }

        // 5. CI verification (DB + live re-check via GitHubClient if available)
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

        let ciVerified = matchingRuns.some(
          (r) =>
            Array.isArray(r.jobs) &&
            r.jobs.some((j) => j.name === PUBLISH_JOB_NAME && j.conclusion === 'success')
        );

        const ghClient = deps.getGitHubClient?.() ?? null;
        if (ghClient) {
          const remoteRuns = await ghClient.listWorkflowRuns(parsedRepo.repo, {
            branch: 'main',
            headSha: commitSha,
            perPage: 10,
          });
          const greenRun = remoteRuns.find(
            (r) => r.status === 'completed' && r.conclusion === 'success'
          );
          if (!greenRun) {
            ciVerified = false;
          } else {
            const remoteJobs = await ghClient.listWorkflowJobs(
              parsedRepo.repo,
              greenRun.id,
              greenRun.runAttempt
            );
            ciVerified = remoteJobs.some(
              (j) => j.name === PUBLISH_JOB_NAME && j.conclusion === 'success'
            );
          }
        }

        if (!ciVerified) {
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

        const releaseName = ctx.service.slug;

        // No-op check (only when not explicitly rolling back and same commit/image is already healthy)
        let isNoop = false;
        if (
          !dep.rollback_of &&
          env.deployed_commit_sha === commitSha &&
          env.deployed_image === image
        ) {
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
        await ctx.saveResource('rollbackOf', dep.rollback_of ?? null);
        await ctx.saveResource('environmentId', env.id);
        await ctx.saveResource('hadPriorDeployment', env.deployed_commit_sha !== null);
        await ctx.saveResource('priorDeployedImage', env.deployed_image ?? null);
        await ctx.saveResource('releaseName', releaseName);
        await ctx.saveResource('imageRepository', repository);
        await ctx.saveResource('image', image);
        await ctx.saveResource('commitSha', commitSha);
        await ctx.saveResource('chartPath', chartPath);
        await ctx.saveResource('noop', isNoop);
      },
    },
    {
      key: 'prepare',
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
            'Missing required environment variables: GHCR_PULL_USERNAME and GHCR_PULL_TOKEN (see docs/ghcr-setup.md)'
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
      key: 'deploy',
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
        const chartPath = String(ctx.resources.chartPath ?? SERVICE_CHART_PATH);
        const timeoutSeconds = deps.getDeployTimeoutSeconds?.() ?? 300;
        const environmentId = String(ctx.resources.environmentId);
        const hadPrior = ctx.resources.hadPriorDeployment === true;
        const priorImage =
          typeof ctx.resources.priorDeployedImage === 'string'
            ? ctx.resources.priorDeployedImage
            : null;

        await ctx.log(
          'info',
          `Running helm upgrade --install ${releaseName} with image ${imageRepository}:${commitSha} (timeout=${timeoutSeconds}s)`
        );

        try {
          const releaseStatus = await deployHelmRelease(runner, {
            releaseName,
            serviceSlug: ctx.service!.slug,
            imageRepository,
            imageTag: commitSha,
            imagePullSecretName: ghcrSecretName,
            dbSecretName,
            nodePort,
            commitSha,
            chartPath,
            timeoutSeconds,
          });

          await ctx.saveResource('helmRevision', releaseStatus.revision);
          await ctx.log(
            'info',
            `Helm release '${releaseName}' at revision ${releaseStatus.revision ?? 'unknown'} (${releaseStatus.status ?? 'unknown'})`
          );
        } catch (err) {
          await observeEnvironmentAfterFailure(
            runner,
            environmentId,
            ctx.service!.slug,
            priorImage,
            hadPrior
          );
          throw err;
        }
      },
    },
    {
      key: 'verify',
      name: DEPLOY_STEP_DEFINITIONS[3].name,
      run: async (ctx) => {
        const deploymentId = String(ctx.resources.deploymentId);
        const environmentId = String(ctx.resources.environmentId);
        const commitSha = String(ctx.resources.commitSha);
        const image = String(ctx.resources.image);
        const rollbackOf =
          typeof ctx.resources.rollbackOf === 'string' ? ctx.resources.rollbackOf : null;
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

        if (rollbackOf) {
          const priorSucceeded = await db
            .select({ id: deployments.id })
            .from(deployments)
            .where(
              and(
                eq(deployments.environment_id, environmentId),
                eq(deployments.status, 'succeeded'),
                ne(deployments.id, deploymentId)
              )
            );
          for (const prev of priorSucceeded) {
            await transitionDeployment(db, prev.id, 'succeeded', 'rolled_back');
          }
        }

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
