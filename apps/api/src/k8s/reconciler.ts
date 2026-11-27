import { eq, isNotNull } from 'drizzle-orm';
import type { EnvironmentStatus } from '@forgeflow/shared-types';
import { db } from '../db/client.js';
import { environments, services } from '../db/schema.js';
import type { K8sRunner } from './exec.js';
import { redactSecrets } from '../utils/redact.js';

interface K8sDeploymentItem {
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

export interface ReconcileResult {
  checked: number;
  updated: number;
  errors: number;
}

/**
 * Reconciles deployed environments in PostgreSQL with live Kubernetes Deployment state
 * in the forgeflow-dev namespace.
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
  try {
    const res = await runner.kubectl(['get', 'deployments', '-o', 'json']);
    const parsed = JSON.parse(res.stdout) as { items?: K8sDeploymentItem[] };
    k8sDeployments = Array.isArray(parsed.items) ? parsed.items : [];
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    const now = new Date();
    for (const { env } of deployedEnvs) {
      await db
        .update(environments)
        .set({
          last_observed_at: now,
          last_observed_error: `Cluster observation failed: ${msg}`,
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
    const item = byName.get(serviceSlug);
    let nextStatus: EnvironmentStatus;
    let observedImage: string | null = null;
    let observedReplicas = 0;
    let observedReadyReplicas = 0;
    let observedError: string | null = null;

    if (!item) {
      nextStatus = 'failed';
      observedError = `Deployment '${serviceSlug}' missing from cluster`;
    } else {
      observedImage = item.spec?.template?.spec?.containers?.[0]?.image ?? null;
      const specReplicas = item.spec?.replicas ?? 1;
      observedReplicas = item.status?.replicas ?? 0;
      observedReadyReplicas = item.status?.readyReplicas ?? 0;

      if (env.deployed_image && observedImage !== env.deployed_image) {
        nextStatus = 'drifted';
        observedError = `Image drifted: expected '${env.deployed_image}', observed '${observedImage ?? 'none'}'`;
      } else if (observedReadyReplicas === 0 || observedReadyReplicas < specReplicas) {
        nextStatus = 'degraded';
        observedError = `Ready replicas ${observedReadyReplicas}/${Math.max(specReplicas, 1)}`;
      } else {
        nextStatus = 'healthy';
        observedError = null;
      }
    }

    await db
      .update(environments)
      .set({
        status: nextStatus,
        observed_image: observedImage,
        observed_replicas: observedReplicas,
        observed_ready_replicas: observedReadyReplicas,
        last_observed_at: now,
        last_observed_error: observedError,
      })
      .where(eq(environments.id, env.id));

    updated++;
  }

  return { checked: deployedEnvs.length, updated, errors: 0 };
}
