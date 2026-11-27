import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../');
const envPath = path.join(repoRoot, 'apps/api/.env');
dotenv.config({ path: envPath });
console.log(`Loaded env from ${envPath}`);

import { loadEnv, getEnv, getGitHubConfig } from '../config/env.js';
import { claimNext, requeueStale } from '../workflows/queue.js';
import { executeWorkflow, type Step } from '../workflows/executor.js';
import { transitionRun } from '../workflows/state-machine.js';
import { createScaffoldSteps } from '../workflows/steps/scaffold.js';
import { createDeploySteps, type DeployStepsDeps } from '../workflows/steps/deploy.js';
import { createUndeploySteps } from '../workflows/steps/undeploy.js';
import { RealGitHubClient } from '../github/client.js';
import { RealK8sRunner } from '../k8s/exec.js';
import { reconcileEnvironments } from '../k8s/reconciler.js';
import { hasInProgressCiRuns, syncAllServicesCiRuns } from '../modules/ci/service.js';
import { db } from '../db/client.js';

// Ensure environment is validated
loadEnv();

export type StepResolver = (type: string) => Step[];

// Default registry mapping workflow types to step lists
const defaultStepRegistry = new Map<string, Step[]>();

export function registerWorkflowSteps(type: string, steps: Step[]): void {
  defaultStepRegistry.set(type, steps);
}

// Register default scaffold workflow steps (uses real GitHubClient from env)
registerWorkflowSteps(
  'scaffold',
  createScaffoldSteps({
    getGitHubClient: () => {
      const cfg = getGitHubConfig();
      if (!cfg.configured || !cfg.config) return null;
      return new RealGitHubClient(cfg.config);
    },
    getGitHubOrg: () => {
      const cfg = getGitHubConfig();
      return cfg.config?.org ?? null;
    },
  })
);

function getWorkerK8sRunner(): RealK8sRunner | null {
  const env = getEnv();
  const rawPath = env.KUBECONFIG_WORKER_PATH ?? 'secrets/worker-kubeconfig.yaml';
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
  if (!fs.existsSync(resolved)) return null;
  return new RealK8sRunner({
    kubeconfigPath: resolved,
    namespace: env.K8S_NAMESPACE,
  });
}

const deployDeps: DeployStepsDeps = {
  getK8sRunner: getWorkerK8sRunner,
  getGhcrCredentials: () => {
    const env = getEnv();
    if (!env.GHCR_PULL_USERNAME || !env.GHCR_PULL_TOKEN) return null;
    return { username: env.GHCR_PULL_USERNAME, token: env.GHCR_PULL_TOKEN };
  },
  getGitHubClient: () => {
    const cfg = getGitHubConfig();
    if (!cfg.configured || !cfg.config) return null;
    return new RealGitHubClient(cfg.config);
  },
  getExpectedOrg: () => getGitHubConfig().config?.org ?? null,
  getChartPath: () => {
    const raw = getEnv().CHART_PATH;
    if (!raw) return path.resolve(repoRoot, 'infrastructure/helm/service-chart');
    return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  },
  getDeployTimeoutSeconds: () => getEnv().DEPLOY_TIMEOUT_SECONDS,
};

registerWorkflowSteps('deploy', createDeploySteps(deployDeps));
registerWorkflowSteps('undeploy', createUndeploySteps({ getK8sRunner: getWorkerK8sRunner }));

export interface WorkerOptions {
  workerId?: string;
  pollMs?: number;
  stepResolver?: StepResolver;
}

export function createWorker(options: WorkerOptions = {}) {
  const env = getEnv();
  const workerId =
    options.workerId || `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const pollMs = options.pollMs ?? env.WORKER_POLL_MS;
  const stepResolver =
    options.stepResolver || ((type: string) => defaultStepRegistry.get(type) || []);

  let isRunning = false;
  let isShuttingDown = false;
  let currentRunId: string | null = null;
  let staleTimer: NodeJS.Timeout | null = null;
  let ciSyncTimer: NodeJS.Timeout | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;

  async function pollOnce(): Promise<boolean> {
    if (isShuttingDown) return false;

    const run = await claimNext(workerId);
    if (!run) return false;

    currentRunId = run.id;
    try {
      const steps = stepResolver(run.type);
      await executeWorkflow({
        runId: run.id,
        workerId,
        steps,
      });
    } catch (err) {
      console.error(`[Worker ${workerId}] Error executing run ${run.id}:`, err);
    } finally {
      currentRunId = null;
    }

    return true;
  }

  async function start() {
    isRunning = true;
    console.log(`[Worker ${workerId}] Starting workflow worker (poll: ${pollMs}ms)...`);
    const githubCfg = getGitHubConfig();
    console.log(
      `GitHub integration: configured=${githubCfg.configured} org=${githubCfg.config?.org ?? 'none'}`
    );

    // Initial requeue of stale runs
    try {
      const recovered = await requeueStale();
      if (recovered > 0) {
        console.log(`[Worker ${workerId}] Recovered ${recovered} stale workflow runs on startup`);
      }
    } catch (err) {
      console.error(`[Worker ${workerId}] Initial requeueStale failed:`, err);
    }

    // Periodic stale recovery every 30s
    staleTimer = setInterval(async () => {
      try {
        await requeueStale();
      } catch (err) {
        console.error(`[Worker ${workerId}] Periodic requeueStale failed:`, err);
      }
    }, 30000);

    // Periodic CI status sync when GitHub App is configured:
    // Uses 15s while any run is in progress, otherwise CI_SYNC_INTERVAL_MS (default 60s), with ±15% jitter.
    const scheduleNextCiSync = async () => {
      if (isShuttingDown || !isRunning) return;
      let inProgress = false;
      try {
        inProgress = await hasInProgressCiRuns();
      } catch {
        inProgress = false;
      }
      const baseMs = inProgress
        ? Math.min(15000, env.CI_SYNC_INTERVAL_MS)
        : env.CI_SYNC_INTERVAL_MS;
      const jitter = baseMs * (0.85 + Math.random() * 0.3);
      ciSyncTimer = setTimeout(async () => {
        if (isShuttingDown || !isRunning) return;
        const cfg = getGitHubConfig();
        if (cfg.configured && cfg.config) {
          try {
            const client = new RealGitHubClient(cfg.config);
            await syncAllServicesCiRuns(client, cfg.config.org);
          } catch (err) {
            console.error(`[Worker ${workerId}] Periodic CI sync failed:`, err);
          }
        }
        void scheduleNextCiSync();

        // Periodic Kubernetes environment reconciliation
        reconcileTimer = setInterval(async () => {
          const runner = getWorkerK8sRunner();
          if (!runner) return;
          try {
            await reconcileEnvironments(runner);
          } catch (err) {
            console.error(`[Worker ${workerId}] Periodic K8s reconcile failed:`, err);
          }
        }, env.RECONCILE_INTERVAL_MS);
      }, Math.round(jitter));
    };
    void scheduleNextCiSync();

    // Periodic Kubernetes environment reconciliation
    reconcileTimer = setInterval(async () => {
      const runner = getWorkerK8sRunner();
      if (!runner) return;
      try {
        await reconcileEnvironments(runner);
      } catch (err) {
        console.error(`[Worker ${workerId}] Periodic K8s reconcile failed:`, err);
      }
    }, env.RECONCILE_INTERVAL_MS);

    // Main poll loop (one run at a time)
    while (isRunning && !isShuttingDown) {
      try {
        const worked = await pollOnce();
        if (!worked && !isShuttingDown) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } catch (err) {
        console.error(`[Worker ${workerId}] Poll error:`, err);
        if (!isShuttingDown) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      }
    }
  }

  async function stop(gracePeriodMs = 30000) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    isRunning = false;

    console.log(`[Worker ${workerId}] Shutting down gracefully...`);
    if (staleTimer) {
      clearInterval(staleTimer);
      staleTimer = null;
    }
    if (ciSyncTimer) {
      clearTimeout(ciSyncTimer);
      ciSyncTimer = null;
    }
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }

    if (currentRunId) {
      console.log(
        `[Worker ${workerId}] Waiting for run ${currentRunId} to finish (up to ${gracePeriodMs}ms)...`
      );
      const startTime = Date.now();
      while (currentRunId && Date.now() - startTime < gracePeriodMs) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // If still running after grace period, release lock back to queued
      if (currentRunId) {
        console.warn(
          `[Worker ${workerId}] Run ${currentRunId} exceeded grace period. Releasing back to queued.`
        );
        try {
          await transitionRun(
            db,
            currentRunId,
            'running',
            'queued',
            {
              locked_at: null,
              locked_by: null,
            },
            { workerId }
          );
        } catch (releaseErr) {
          console.error(`[Worker ${workerId}] Failed to release run ${currentRunId}:`, releaseErr);
        }
      }
    }

    console.log(`[Worker ${workerId}] Stopped.`);
  }

  return {
    workerId,
    start,
    stop,
    pollOnce,
  };
}

// When executed directly as process entrypoint
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*[/\\]/, ''))) {
  const worker = createWorker();

  const handleShutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Gracefully stopping worker...`);
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  worker.start().catch((err) => {
    console.error('Fatal worker error:', err);
    process.exit(1);
  });
}
