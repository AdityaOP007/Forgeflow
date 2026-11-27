import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { ListCiRunsResponse, SyncCiRunsResponse } from '@forgeflow/shared-types';
import { requireRole } from '../../middleware/requireRole.js';
import { getGitHubConfig } from '../../config/env.js';
import { RealGitHubClient } from '../../github/client.js';
import type { GitHubClient } from '../../github/types.js';
import { listServiceCiRuns, syncServiceCiRuns } from './service.js';

export interface CiRouterOptions {
  createGitHubClient?: () => { client: GitHubClient; org: string } | null;
}

interface HttpError extends Error {
  statusCode?: number;
  code?: string;
}

function defaultCreateGitHubClient(): { client: GitHubClient; org: string } | null {
  const cfg = getGitHubConfig();
  if (!cfg.configured || !cfg.config) return null;
  return {
    client: new RealGitHubClient(cfg.config),
    org: cfg.config.org,
  };
}

export function createCiRouter(options: CiRouterOptions = {}): Router {
  const router = Router({ mergeParams: true });
  const getClient = options.createGitHubClient ?? defaultCreateGitHubClient;

  // GET /api/services/:id/ci-runs
  router.get(
    '/:id/ci-runs',
    async (req: Request, res: Response<ListCiRunsResponse>, next: NextFunction) => {
      try {
        const runs = await listServiceCiRuns(req.params.id);
        res.json({ data: runs });
      } catch (err) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode === 404) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: httpErr.message },
          } as unknown as ListCiRunsResponse);
          return;
        }
        next(err);
      }
    }
  );

  // POST /api/services/:id/ci-runs/sync
  router.post(
    '/:id/ci-runs/sync',
    requireRole('developer', 'admin'),
    async (req: Request, res: Response<SyncCiRunsResponse>, next: NextFunction) => {
      try {
        const gh = getClient();
        if (!gh) {
          res.status(503).json({
            error: {
              code: 'GITHUB_NOT_CONFIGURED',
              message: 'GitHub App integration is not configured',
            },
          } as unknown as SyncCiRunsResponse);
          return;
        }
        const { runs, synced } = await syncServiceCiRuns(req.params.id, gh.client, gh.org);
        res.json({ data: runs, synced });
      } catch (err) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode === 404) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: httpErr.message },
          } as unknown as SyncCiRunsResponse);
          return;
        }
        next(err);
      }
    }
  );

  return router;
}

