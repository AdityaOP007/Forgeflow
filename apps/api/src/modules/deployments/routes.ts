import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  deployServiceSchema,
  listDeploymentsQuerySchema,
  rollbackDeploymentSchema,
  type DeployServiceResponse,
  type DeploymentItem,
  type ListDeploymentsQuery,
  type ListDeploymentsResponse,
  type PaginatedResponse,
  type UndeployServiceResponse,
} from '@forgeflow/shared-types';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import {
  getDeploymentById,
  listDeployments,
  listServiceDeployments,
  triggerDeploy,
  triggerRollbackByDeploymentId,
  triggerUndeploy,
} from './service.js';

interface HttpError extends Error {
  statusCode?: number;
  code?: string;
}

function handleKnownHttpError(err: unknown, res: Response, next: NextFunction): void {
  const httpErr = err as HttpError;
  if (httpErr.statusCode && httpErr.statusCode < 500) {
    res.status(httpErr.statusCode).json({
      error: { code: httpErr.code || 'BAD_REQUEST', message: httpErr.message },
    });
    return;
  }
  next(err);
}

/** Mounted at /api/services */
export function createServiceDeploymentsRouter(): Router {
  const router = Router({ mergeParams: true });

  // GET /api/services/:id/deployments
  router.get(
    '/:id/deployments',
    async (req: Request, res: Response<ListDeploymentsResponse>, next: NextFunction) => {
      try {
        const data = await listServiceDeployments(req.params.id);
        res.json({ data });
      } catch (err) {
        handleKnownHttpError(err, res, next);
      }
    }
  );

  // POST /api/services/:id/deployments
  router.post(
    '/:id/deployments',
    requireRole('developer', 'admin'),
    validate(deployServiceSchema),
    async (req: Request, res: Response<DeployServiceResponse>, next: NextFunction) => {
      try {
        const result = await triggerDeploy(
          req.params.id,
          req.body,
          req.auth!.userId!,
          req.auth!.role!
        );
        res.status(result.noop ? 200 : 202).json(result);
      } catch (err) {
        handleKnownHttpError(err, res, next);
      }
    }
  );

  // POST /api/services/:id/environments/development/undeploy
  router.post(
    '/:id/environments/development/undeploy',
    requireRole('developer', 'admin'),
    async (req: Request, res: Response<UndeployServiceResponse>, next: NextFunction) => {
      try {
        const result = await triggerUndeploy(
          req.params.id,
          'development',
          req.auth!.userId!,
          req.auth!.role!
        );
        res.status(202).json(result);
      } catch (err) {
        handleKnownHttpError(err, res, next);
      }
    }
  );

  return router;
}

/** Mounted at /api/deployments */
export function createDeploymentsRouter(): Router {
  const router = Router();

  // GET /api/deployments (paginated; filters status, serviceId, environment)
  router.get(
    '/',
    validate(listDeploymentsQuerySchema, 'query'),
    async (req: Request, res: Response<PaginatedResponse<DeploymentItem>>, next: NextFunction) => {
      try {
        const result = await listDeployments(req.query as unknown as ListDeploymentsQuery);
        res.json(result);
      } catch (err) {
        handleKnownHttpError(err, res, next);
      }
    }
  );

  // GET /api/deployments/:id
  router.get('/:id', async (req: Request, res: Response<DeploymentItem>, next: NextFunction) => {
    try {
      const deployment = await getDeploymentById(req.params.id);
      if (!deployment) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Deployment not found' },
        } as unknown as DeploymentItem);
        return;
      }
      res.json(deployment);
    } catch (err) {
      handleKnownHttpError(err, res, next);
    }
  });

  // POST /api/deployments/:id/rollback
  router.post(
    '/:id/rollback',
    requireRole('developer', 'admin'),
    validate(rollbackDeploymentSchema),
    async (req: Request, res: Response<DeployServiceResponse>, next: NextFunction) => {
      try {
        const result = await triggerRollbackByDeploymentId(
          req.params.id,
          req.body,
          req.auth!.userId!,
          req.auth!.role!
        );
        res.status(202).json(result);
      } catch (err) {
        handleKnownHttpError(err, res, next);
      }
    }
  );

  return router;
}
