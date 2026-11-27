import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  deployServiceSchema,
  rollbackServiceSchema,
  undeployServiceSchema,
  type DeployServiceResponse,
  type ListDeploymentsResponse,
  type UndeployServiceResponse,
} from '@forgeflow/shared-types';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import {
  listServiceDeployments,
  triggerDeploy,
  triggerRollback,
  triggerUndeploy,
} from './service.js';

interface HttpError extends Error {
  statusCode?: number;
  code?: string;
}

export function createDeploymentsRouter(): Router {
  const router = Router({ mergeParams: true });

  // GET /api/services/:id/deployments
  router.get(
    '/:id/deployments',
    async (req: Request, res: Response<ListDeploymentsResponse>, next: NextFunction) => {
      try {
        const data = await listServiceDeployments(req.params.id);
        res.json({ data });
      } catch (err) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode && httpErr.statusCode < 500) {
          res.status(httpErr.statusCode).json({
            error: { code: httpErr.code || 'BAD_REQUEST', message: httpErr.message },
          } as unknown as ListDeploymentsResponse);
          return;
        }
        next(err);
      }
    }
  );

  // POST /api/services/:id/deploy
  router.post(
    '/:id/deploy',
    requireRole('developer', 'admin'),
    validate(deployServiceSchema),
    async (req: Request, res: Response<DeployServiceResponse>, next: NextFunction) => {
      try {
        const result = await triggerDeploy(req.params.id, req.body, req.auth!.userId!);
        res.status(202).json(result);
      } catch (err) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode && httpErr.statusCode < 500) {
          res.status(httpErr.statusCode).json({
            error: { code: httpErr.code || 'BAD_REQUEST', message: httpErr.message },
          } as unknown as DeployServiceResponse);
          return;
        }
        next(err);
      }
    }
  );

  // POST /api/services/:id/rollback
  router.post(
    '/:id/rollback',
    requireRole('developer', 'admin'),
    validate(rollbackServiceSchema),
    async (req: Request, res: Response<DeployServiceResponse>, next: NextFunction) => {
      try {
        const result = await triggerRollback(req.params.id, req.body, req.auth!.userId!);
        res.status(202).json(result);
      } catch (err) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode && httpErr.statusCode < 500) {
          res.status(httpErr.statusCode).json({
            error: { code: httpErr.code || 'BAD_REQUEST', message: httpErr.message },
          } as unknown as DeployServiceResponse);
          return;
        }
        next(err);
      }
    }
  );

  // POST /api/services/:id/undeploy
  router.post(
    '/:id/undeploy',
    requireRole('developer', 'admin'),
    validate(undeployServiceSchema),
    async (req: Request, res: Response<UndeployServiceResponse>, next: NextFunction) => {
      try {
        const result = await triggerUndeploy(req.params.id, req.body, req.auth!.userId!);
        res.status(202).json(result);
      } catch (err) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode && httpErr.statusCode < 500) {
          res.status(httpErr.statusCode).json({
            error: { code: httpErr.code || 'BAD_REQUEST', message: httpErr.message },
          } as unknown as UndeployServiceResponse);
          return;
        }
        next(err);
      }
    }
  );

  return router;
}
