import { eq, isNotNull } from 'drizzle-orm';
import type { EnvironmentStatus } from '@forgeflow/shared-types';
import { db } from '../db/client.js';
import { environments, services } from '../db/schema.js';
import type { K8sRunner } from './exec.js';
import { redactSecrets } from '../utils/redact.js';

export interface K8sDeploymentItem {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    replicas?: number;
    template?: {
      spec?: {
        containers?: Array<{ image?: string }>;
      };
    };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
  };
}

export interface K8sPodItem {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
  };
  status?: {
    containerStatuses?: Array<{
      state?: {
        waiting?: { reason?: string; message?: string };
        terminated?: { reason?: string; message?: string };
      };
      lastState?: {
        terminated?: { reason?: string; message?: string };
      };
    }>;
  };
}

export interface EnvironmentObservation {
  status: EnvironmentStatus;
  observedImage: string | null;
  observedReplicas: number | null;
  observedReadyReplicas: number | null;
  lastObservedError: string | null;
  preservePreviousStatus?: boolean;
}

const FAILURE_POD_REASONS = new Set(['ImagePullBackOff', 'ErrImagePull', 'CrashLoopBackOff']);

export function extractPodFailureReason(pods: K8sPodItem[]): string | null {
  for (const pod of pods) {
    const statuses = pod.status?.containerStatuses ?? [];
    for (const cs of statuses) {
      const waitingReason = cs.state?.waiting?.reason;
      if (waitingReason && FAILURE_POD_REASONS.has(waitingReason)) {
        const msg = cs.state?.waiting?.message;
        return msg ? `${waitingReason}: ${redactSecrets(msg)}` : waitingReason;
      }
      const termReason = cs.state?.terminated?.reason;
      if (termReason && FAILURE_POD_REASONS.has(termReason)) {
        const msg = cs.state?.terminated?.message;
        return msg ? `${termReason}: ${redactSecrets(msg)}` : termReason;
      }
    }
  }
  return null;
}

/**
 * Pure status computation for a deployed environment.
 * Never uses 'drifted'.
 * - clusterReachable === false -> status 'unknown' (preservePreviousStatus: true when previous status should not be overwritten with failed)
 * - deployment missing when deployedImage is recorded -> 'failed'
 * - desired === 0 or ready === 0 or pod in ImagePullBackOff/ErrImagePull/CrashLoopBackOff -> 'failed'
 * - 0 < ready < desired or runningImage !== deployedImage -> 'degraded'
 * - desired > 0 && ready === desired && runningImage === deployedImage -> 'healthy'
 */
export function computeEnvironmentObservation(input: {
  deployedImage: string | null;
  deployment: K8sDeploymentItem | null;
  pods?: K8sPodItem[];
  clusterReachable?: boolean;
  reachabilityError?: string;
}): EnvironmentObservation {
  if (input.clusterReachable === false) {
    return {
      status: 'unknown',
      observedImage: null,
      observedReplicas: null,
      observedReadyReplicas: null,
      lastObservedError: input.reachabilityError
        ? `Cluster unreachable: ${redactSecrets(input.reachabilityError)}`
        : 'Cluster unreachable',
      preservePreviousStatus: true,
    };
  }

  if (!input.deployment) {
    return {
      status: input.deployedImage ? 'failed' : 'unknown',
      observedImage: null,
      observedReplicas: 0,
      observedReadyReplicas: 0,
      lastObservedError: input.deployedImage ? 'Deployment missing from cluster' : null,
    };
  }

  const runningImage = input.deployment.spec?.template?.spec?.containers?.[0]?.image ?? null;
  const desired = input.deployment.spec?.replicas ?? 1;
  const ready = input.deployment.status?.readyReplicas ?? 0;
  const podFailure = extractPodFailureReason(input.pods ?? []);

  if (podFailure) {
    return {
      status: 'failed',
      observedImage: runningImage,
      observedReplicas: desired,
      observedReadyReplicas: ready,
      lastObservedError: podFailure,
    };
  }

  if (desired === 0 || ready === 0) {
    return {
      status: 'failed',
      observedImage: runningImage,
      observedReplicas: desired,
      observedReadyReplicas: ready,
      lastObservedError:
        desired === 0 ? 'Deployment scaled to 0 replicas' : `0/${desired} replicas ready`,
    };
  }

  if (ready < desired) {
    return {
      status: 'degraded',
      observedImage: runningImage,
      observedReplicas: desired,
      observedReadyReplicas: ready,
      lastObservedError: `Ready replicas ${ready}/${desired}`,
    };
  }

  if (input.deployedImage && runningImage !== input.deployedImage) {
    return {
      status: 'degraded',
      observedImage: runningImage,
      observedReplicas: desired,
      observedReadyReplicas: ready,
      lastObservedError: `Running image '${runningImage ?? 'none'}' differs from deployed image '${input.deployedImage}'`,
    };
  }

  return {
    status: 'healthy',
    observedImage: runningImage,
    observedReplicas: desired,
    observedReadyReplicas: ready,
    lastObservedError: null,
  };
}

export interface ReconcileResult {
  checked: number;
  updated: number;
  errors: number;
}

/**
 * Reconciles deployed environments in PostgreSQL with live Kubernetes Deployment & Pod state.
 */
export async function reconcileEnvironments(runner: K8sRunner): Promise<ReconcileResult> {
  const deployedEnvs = await db
    .select({
      env: environments,
      serviceSlug: services.slug,
    })
    .from(environments)
    .innerJoin(services, eq(environments.service_id, services.id))
    .where(isNotNull(environments.deployed_commit_sha));

  if (deployedEnvs.length === 0) {
    return { checked: 0, updated: 0, errors: 0 };
  }

  let k8sDeployments: K8sDeploymentItem[] = [];
  let k8sPods: K8sPodItem[] = [];
  try {
    const depRes = await runner.kubectl(['get', 'deployments', '-o', 'json']);
    const parsedDeps = JSON.parse(depRes.stdout) as { items?: K8sDeploymentItem[] };
    k8sDeployments = Array.isArray(parsedDeps.items) ? parsedDeps.items : [];

    try {
      const podRes = await runner.kubectl(['get', 'pods', '-o', 'json']);
      const parsedPods = JSON.parse(podRes.stdout) as { items?: K8sPodItem[] };
      k8sPods = Array.isArray(parsedPods.items) ? parsedPods.items : [];
    } catch {
      k8sPods = [];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const obs = computeEnvironmentObservation({
      deployedImage: null,
      deployment: null,
      clusterReachable: false,
      reachabilityError: msg,
    });
    const now = new Date();
    for (const { env } of deployedEnvs) {
      // Never overwrite a good status with 'failed' when cluster is unreachable
      const nextStatus: EnvironmentStatus =
        env.status === 'healthy' || env.status === 'degraded' ? env.status : obs.status;
      await db
        .update(environments)
        .set({
          status: nextStatus,
          last_observed_at: now,
          last_observed_error: obs.lastObservedError,
        })
        .where(eq(environments.id, env.id));
    }
    return { checked: deployedEnvs.length, updated: 0, errors: deployedEnvs.length };
  }

  const byName = new Map<string, K8sDeploymentItem>();
  for (const item of k8sDeployments) {
    const name = item.metadata?.name;
    if (name) byName.set(name, item);
  }

  let updated = 0;
  const now = new Date();

  for (const { env, serviceSlug } of deployedEnvs) {
    const deployment = byName.get(serviceSlug) ?? null;
    const servicePods = k8sPods.filter(
      (p) =>
        p.metadata?.labels?.['app.kubernetes.io/instance'] === serviceSlug ||
        p.metadata?.labels?.['app.kubernetes.io/name'] === serviceSlug ||
        p.metadata?.name?.startsWith(`${serviceSlug}-`)
    );

    const obs = computeEnvironmentObservation({
      deployedImage: env.deployed_image,
      deployment,
      pods: servicePods,
      clusterReachable: true,
    });

    await db
      .update(environments)
      .set({
        status: obs.status,
        observed_image: obs.observedImage,
        observed_replicas: obs.observedReplicas,
        observed_ready_replicas: obs.observedReadyReplicas,
        last_observed_at: now,
        last_observed_error: obs.lastObservedError,
      })
      .where(eq(environments.id, env.id));

    updated++;
  }

  return { checked: deployedEnvs.length, updated, errors: 0 };
}
