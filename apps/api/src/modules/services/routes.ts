import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import {
  createServiceSchema,
  updateServiceSchema,
  updateServiceOwnerSchema,
  scaffoldServiceSchema,
  listServicesQuerySchema,
} from '@forgeflow/shared-types';
import type { ServiceListItem, PaginatedResponse } from '@forgeflow/shared-types';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import {
  listServices,
  getServiceById,
  createService,
  scaffoldService,
  updateService,
  deleteService,
  writeAuditLog,
} from './service.js';
import { createCiRouter, type CiRouterOptions } from '../ci/routes.js';
import { createServiceDeploymentsRouter } from '../deployments/routes.js';
import { db } from '../../db/client.js';
import { services, users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export interface ServicesRouterOptions {
  isGitHubConfigured?: () => boolean;
  createGitHubClient?: CiRouterOptions['createGitHubClient'];
}

interface HttpError extends Error {
  statusCode?: number;
  code?: string;
}

export function createServicesRouter(options: ServicesRouterOptions = {}): Router {
  const router = Router();

  const scaffoldLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many scaffold requests, please try again later',
      },
    },
  });

  // GET /api/services — paginated list
  router.get(
    '/',
    validate(listServicesQuerySchema, 'query'),
    async (req: Request, res: Response<PaginatedResponse<ServiceListItem>>, next: NextFunction) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await listServices(req.query as any);
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/services/scaffold — async scaffold workflow (developer or admin)
  router.post(
    '/scaffold',
    scaffoldLimiter,
    requireRole('developer', 'admin'),
    validate(scaffoldServiceSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await scaffoldService(
          req.body,
          req.auth!.userId!,
          options.isGitHubConfigured
        );
        res.status(202).json(result);
      } catch (err: unknown) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode && httpErr.statusCode < 500) {
          res.status(httpErr.statusCode).json({
            error: {
              code: httpErr.code || (httpErr.statusCode === 409 ? 'CONFLICT' : 'BAD_REQUEST'),
              message: httpErr.message,
            },
          });
          return;
        }
        if (httpErr.statusCode === 503) {
          res.status(503).json({
            error: {
              code: httpErr.code || 'SERVICE_UNAVAILABLE',
              message: httpErr.message,
            },
          });
          return;
        }
        next(err);
      }
    }
  );

  // GET /api/services/:id — detail
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = await getServiceById(req.params.id);
      if (!service) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Service not found' },
        });
        return;
      }
      res.json(service);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/services — manual register (developer or admin)
  router.post(
    '/',
    requireRole('developer', 'admin'),
    validate(createServiceSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const service = await createService(req.body, req.auth!.userId!);
        await writeAuditLog(req.auth!.userId!, 'service.create', 'service', service.id);
        res.status(201).json(service);
      } catch (err: unknown) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode === 409) {
          res.status(409).json({
            error: { code: 'CONFLICT', message: httpErr.message },
          });
          return;
        }
        next(err);
      }
    }
  );

  // PATCH /api/services/:id — update (owner or admin)
  router.patch(
    '/:id',
    requireRole('developer', 'admin'),
    validate(updateServiceSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const existing = await db
          .select({ owner_id: services.owner_id })
          .from(services)
          .where(eq(services.id, req.params.id))
          .limit(1);

        if (existing.length === 0) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Service not found' },
          });
          return;
        }

        if (req.auth!.role !== 'admin' && existing[0].owner_id !== req.auth!.userId) {
          res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'You can only update your own services' },
          });
          return;
        }

        const updated = await updateService(req.params.id, req.body);
        if (!updated) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Service not found' },
          });
          return;
        }
        await writeAuditLog(req.auth!.userId!, 'service.update', 'service', req.params.id);
        res.json(updated);
      } catch (err: unknown) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode === 409) {
          res.status(409).json({
            error: { code: 'CONFLICT', message: httpErr.message },
          });
          return;
        }
        next(err);
      }
    }
  );

  // PATCH /api/services/:id/owner — transfer service ownership (admin only)
  router.patch(
    '/:id/owner',
    requireRole('admin'),
    validate(updateServiceOwnerSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { ownerId } = req.body as { ownerId: string };
        const [existing] = await db
          .select({ id: services.id })
          .from(services)
          .where(eq(services.id, req.params.id))
          .limit(1);

        if (!existing) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Service not found' },
          });
          return;
        }

        const [targetUser] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, ownerId))
          .limit(1);

        if (!targetUser) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Target owner user not found' },
          });
          return;
        }

        await db
          .update(services)
          .set({ owner_id: ownerId, updated_at: new Date() })
          .where(eq(services.id, req.params.id));

        await writeAuditLog(req.auth!.userId!, 'service.owner_updated', 'service', req.params.id);
        const updated = await getServiceById(req.params.id);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /api/services/:id — delete (owner or admin)
  router.delete(
    '/:id',
    requireRole('developer', 'admin'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const existing = await db
          .select({ owner_id: services.owner_id })
          .from(services)
          .where(eq(services.id, req.params.id))
          .limit(1);

        if (existing.length === 0) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Service not found' },
          });
          return;
        }

        if (req.auth!.role !== 'admin' && existing[0].owner_id !== req.auth!.userId) {
          res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'You can only delete your own services' },
          });
          return;
        }

        await deleteService(req.params.id);
        await writeAuditLog(req.auth!.userId!, 'service.delete', 'service', req.params.id);
        res.status(204).send();
      } catch (err: unknown) {
        const httpErr = err as HttpError;
        if (httpErr.statusCode === 409) {
          res.status(409).json({
            error: { code: httpErr.code || 'CONFLICT', message: httpErr.message },
          });
          return;
        }
        next(err);
      }
    }
  );

  router.use(createCiRouter({ createGitHubClient: options.createGitHubClient }));
  router.use(createServiceDeploymentsRouter());

  return router;
}

export const servicesRouter = createServicesRouter();
