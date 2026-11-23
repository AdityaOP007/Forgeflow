import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  createServiceSchema,
  updateServiceSchema,
  listServicesQuerySchema,
} from '@forgeflow/shared-types';
import type { ServiceListItem, PaginatedResponse } from '@forgeflow/shared-types';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import {
  listServices,
  getServiceById,
  createService,
  updateService,
  deleteService,
  writeAuditLog,
} from './service.js';
import { db } from '../../db/client.js';
import { services } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export const servicesRouter = Router();

interface HttpError extends Error {
  statusCode?: number;
}

// GET /api/services — paginated list
servicesRouter.get(
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

// GET /api/services/:id — detail
servicesRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
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

// POST /api/services — create (developer or admin)
servicesRouter.post(
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
servicesRouter.patch(
  '/:id',
  requireRole('developer', 'admin'),
  validate(updateServiceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check ownership
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

// DELETE /api/services/:id — delete (owner or admin)
servicesRouter.delete(
  '/:id',
  requireRole('developer', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check ownership
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

      await writeAuditLog(req.auth!.userId!, 'service.delete', 'service', req.params.id);
      await deleteService(req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);
