import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { getHelmRollbackFlag, K8sCommandError, type K8sRunner } from './exec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVICE_CHART_PATH = path.resolve(
  __dirname,
  '../../../../infrastructure/helm/service-chart'
);

export interface HelmReleaseStatus {
  exists: boolean;
  revision: number | null;
  status: string | null;
}

export function parseHelmStatusJson(stdout: string): HelmReleaseStatus {
  const parsed = JSON.parse(stdout) as {
    version?: number;
    info?: { status?: string };
  };
  return {
    exists: true,
    revision: typeof parsed.version === 'number' ? parsed.version : null,
    status: parsed.info?.status ?? null,
  };
}

export async function getHelmReleaseStatus(
  runner: K8sRunner,
  releaseName: string
): Promise<HelmReleaseStatus> {
  try {
    const res = await runner.helm(['status', releaseName, '-o', 'json']);
    return parseHelmStatusJson(res.stdout);
  } catch (err) {
    if (err instanceof K8sCommandError && /not found/i.test(err.stderr + ' ' + err.message)) {
      return { exists: false, revision: null, status: null };
    }
    throw err;
  }
}

export async function ensureGhcrPullSecret(
  runner: K8sRunner,
  secretName: string,
  username: string,
  token: string
): Promise<void> {
  const auth = Buffer.from(`${username}:${token}`).toString('base64');
  const dockerconfig = JSON.stringify({
    auths: {
      'ghcr.io': {
        username,
        password: token,
        auth,
      },
    },
  });

  const manifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretName },
    type: 'kubernetes.io/dockerconfigjson',
    data: {
      '.dockerconfigjson': Buffer.from(dockerconfig).toString('base64'),
    },
  });

  await runner.kubectl(['apply', '-f', '-'], { stdin: manifest });
}

export async function ensureDbSecret(
  runner: K8sRunner,
  secretName: string,
  serviceSlug: string
): Promise<void> {
  try {
    await runner.kubectl(['get', 'secret', secretName, '-o', 'name']);
    return;
  } catch (err) {
    if (!(err instanceof K8sCommandError) || !/not found/i.test(err.stderr + ' ' + err.message)) {
      throw err;
    }
  }

  const password = crypto.randomBytes(18).toString('base64url');
  const dbName = serviceSlug.replace(/-/g, '_');
  const manifest = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretName },
    type: 'Opaque',
    stringData: {
      POSTGRES_USER: 'appuser',
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: dbName,
    },
  });

  await runner.kubectl(['apply', '-f', '-'], { stdin: manifest });
}

export interface DeployHelmParams {
  releaseName: string;
  serviceSlug: string;
  imageRepository: string;
  imageTag: string;
  imagePullSecretName: string;
  dbSecretName: string;
  nodePort: number;
  commitSha: string;
  chartPath?: string;
}

export async function deployHelmRelease(
  runner: K8sRunner,
  params: DeployHelmParams
): Promise<HelmReleaseStatus> {
  const rollbackFlag = await getHelmRollbackFlag(runner);
  const valuesPayload = JSON.stringify({
    name: params.serviceSlug,
    image: {
      repository: params.imageRepository,
      tag: params.imageTag,
      pullPolicy: 'IfNotPresent',
    },
    imagePullSecretName: params.imagePullSecretName,
    port: 8000,
    nodePort: params.nodePort,
    replicas: 1,
    commitSha: params.commitSha,
    database: {
      enabled: true,
      existingSecret: params.dbSecretName,
      storage: '1Gi',
    },
  });

  await runner.helm(
    [
      'upgrade',
      '--install',
      params.releaseName,
      params.chartPath ?? SERVICE_CHART_PATH,
      '-f',
      '-',
      rollbackFlag,
      '--wait',
      '--timeout',
      '180s',
    ],
    { stdin: valuesPayload, timeoutMs: 210_000 }
  );

  return getHelmReleaseStatus(runner, params.releaseName);
}

export async function uninstallHelmRelease(
  runner: K8sRunner,
  releaseName: string,
  serviceSlug: string
): Promise<{ uninstalled: boolean }> {
  const status = await getHelmReleaseStatus(runner, releaseName);
  let uninstalled = false;
  if (status.exists) {
    await runner.helm(['uninstall', releaseName, '--wait'], { timeoutMs: 120_000 });
    uninstalled = true;
  }

  // Clean up generated secrets and Postgres PVC
  await runner.kubectl([
    'delete',
    'secret',
    `${serviceSlug}-ghcr-pull`,
    `${serviceSlug}-db-secret`,
    '--ignore-not-found=true',
  ]);
  await runner.kubectl([
    'delete',
    'pvc',
    `data-${releaseName}-postgres-0`,
    '--ignore-not-found=true',
  ]);

  return { uninstalled };
}

export interface ClusterDeploymentInfo {
  exists: boolean;
  image: string | null;
  specReplicas: number;
  replicas: number;
  readyReplicas: number;
  commitShaAnnotation: string | null;
}

export async function getClusterDeploymentInfo(
  runner: K8sRunner,
  deploymentName: string
): Promise<ClusterDeploymentInfo> {
  try {
    const res = await runner.kubectl(['get', 'deployment', deploymentName, '-o', 'json']);
    const parsed = JSON.parse(res.stdout) as {
      metadata?: { annotations?: Record<string, string> };
      spec?: {
        replicas?: number;
        template?: { spec?: { containers?: Array<{ image?: string }> } };
      };
      status?: { replicas?: number; readyReplicas?: number };
    };
    return {
      exists: true,
      image: parsed.spec?.template?.spec?.containers?.[0]?.image ?? null,
      specReplicas: parsed.spec?.replicas ?? 1,
      replicas: parsed.status?.replicas ?? 0,
      readyReplicas: parsed.status?.readyReplicas ?? 0,
      commitShaAnnotation: parsed.metadata?.annotations?.['forgeflow.io/commit-sha'] ?? null,
    };
  } catch (err) {
    if (err instanceof K8sCommandError && /not found/i.test(err.stderr + ' ' + err.message)) {
      return {
        exists: false,
        image: null,
        specReplicas: 0,
        replicas: 0,
        readyReplicas: 0,
        commitShaAnnotation: null,
      };
    }
    throw err;
  }
}

export async function checkHttpHealth(
  url: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  for (const suffix of ['/health', '/health/ready']) {
    try {
      const res = await fetchFn(`${url}${suffix}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { ok: false, error: `${suffix} returned HTTP ${res.status}` };
      }
    } catch (err) {
      return {
        ok: false,
        error: `${suffix} check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { ok: true };
}
