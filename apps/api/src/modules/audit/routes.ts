import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import {
  listAuditLogsQuerySchema,
  type AuditLogItem,
  type ListAuditLogsQuery,
  type PaginatedResponse,
} from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { auditLogs, users } from '../../db/schema.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';

export const auditRouter = Router();

// GET /api/audit-logs — admin and developer (viewer 403)
auditRouter.get(
  '/',
  requireRole('admin', 'developer'),
  validate(listAuditLogsQuerySchema, 'query'),
  async (req: Request, res: Response<PaginatedResponse<AuditLogItem>>, next: NextFunction) => {
    try {
      const { page, pageSize, action, resourceType, actorId, from, to } =
        req.query as unknown as ListAuditLogsQuery;
      const offset = (page - 1) * pageSize;

      const conditions = [];
      if (action) conditions.push(eq(auditLogs.action, action));
      if (resourceType) conditions.push(eq(auditLogs.resource_type, resourceType));
      if (actorId) conditions.push(eq(auditLogs.actor_id, actorId));
      if (from) conditions.push(gte(auditLogs.timestamp, new Date(from)));
      if (to) conditions.push(lte(auditLogs.timestamp, new Date(to)));

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [{ value: total }] = await db
        .select({ value: count() })
        .from(auditLogs)
        .where(whereClause);

      const rows = await db
        .select({
          id: auditLogs.id,
          actorId: auditLogs.actor_id,
          actorName: users.name,
          actorEmail: users.email,
          action: auditLogs.action,
          resourceType: auditLogs.resource_type,
          resourceId: auditLogs.resource_id,
          timestamp: auditLogs.timestamp,
        })
        .from(auditLogs)
        .innerJoin(users, eq(auditLogs.actor_id, users.id))
        .where(whereClause)
        .orderBy(desc(auditLogs.timestamp))
        .limit(pageSize)
        .offset(offset);

      res.json({
        data: rows.map((r) => ({
          id: r.id,
          actorId: r.actorId,
          actorName: r.actorName,
          actorEmail: r.actorEmail,
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          timestamp: r.timestamp.toISOString(),
        })),
        total: Number(total),
        page,
        pageSize,
        totalPages: Math.ceil(Number(total) / pageSize),
      });
    } catch (err) {
      next(err);
    }
  }
);
