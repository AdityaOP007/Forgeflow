import { Router } from 'express';
import type { Request, Response } from 'express';
import type { GitHubIntegrationStatus } from '@forgeflow/shared-types';
import { getGitHubConfig, type GitHubConfig } from '../../config/env.js';
import { RealGitHubClient } from '../../github/client.js';
import type { GitHubClient } from '../../github/types.js';
import { redactSecrets } from '../../utils/redact.js';

const CACHE_TTL_MS = 30 * 1000;

interface CachedStatus {
  status: GitHubIntegrationStatus;
  expiresAtMs: number;
}

let cachedStatus: CachedStatus | null = null;

export function resetGitHubIntegrationCache(): void {
  cachedStatus = null;
}

export interface IntegrationsRouterOptions {
  createClient?: (config: GitHubConfig) => GitHubClient;
}

export function createIntegrationsRouter(options: IntegrationsRouterOptions = {}): Router {
  const router = Router();
  const createClient = options.createClient ?? ((cfg: GitHubConfig) => new RealGitHubClient(cfg));

  router.get('/github', async (_req: Request, res: Response<GitHubIntegrationStatus>) => {
    const now = Date.now();
    if (cachedStatus && cachedStatus.expiresAtMs > now) {
      res.json(cachedStatus.status);
      return;
    }

    const cfgResult = getGitHubConfig();
    if (!cfgResult.configured || !cfgResult.config) {
      const status: GitHubIntegrationStatus = {
        configured: false,
        connected: false,
        org: null,
        message: cfgResult.error || 'GitHub App integration is not configured',
      };
      cachedStatus = { status, expiresAtMs: now + CACHE_TTL_MS };
      res.json(status);
      return;
    }

    const { config } = cfgResult;
    try {
      const client = createClient(config);
      const info = await client.getInstallationInfo();
      const orgMatches = info.accountLogin.toLowerCase() === config.org.toLowerCase();

      const status: GitHubIntegrationStatus = orgMatches
        ? {
            configured: true,
            connected: true,
            org: config.org,
            message: `Connected to GitHub organization '${config.org}'`,
          }
        : {
            configured: true,
            connected: false,
            org: config.org,
            message: `Installation account '${info.accountLogin}' does not match GITHUB_ORG '${config.org}'`,
          };

      cachedStatus = { status, expiresAtMs: now + CACHE_TTL_MS };
      res.json(status);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const status: GitHubIntegrationStatus = {
        configured: true,
        connected: false,
        org: config.org,
        message: redactSecrets(rawMsg),
      };
      cachedStatus = { status, expiresAtMs: now + CACHE_TTL_MS };
      res.json(status);
    }
  });

  return router;
}

export const integrationsRouter = createIntegrationsRouter();
