import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { asc, count, eq } from 'drizzle-orm';
import {
  updateUserRoleSchema,
  type ListUsersResponse,
  type UserProfile,
  type UserRole,
} from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { writeAuditLog } from '../services/service.js';

export const usersRouter = Router();

function serializeUser(row: typeof users.$inferSelect): UserProfile {
  return {
    id: row.id,
    clerkId: row.clerk_id,
    name: row.name,
    email: row.email,
    role: row.role as UserRole,
    createdAt: row.created_at.toISOString(),
  };
}

// GET /api/users — admin only
usersRouter.get(
  '/',
  requireRole('admin'),
  async (_req: Request, res: Response<ListUsersResponse>, next: NextFunction) => {
    try {
      const rows = await db.select().from(users).orderBy(asc(users.created_at));
      res.json({ data: rows.map(serializeUser) });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/users/:id/role — admin only
usersRouter.patch(
  '/:id/role',
  requireRole('admin'),
  validate(updateUserRoleSchema),
  async (req: Request, res: Response<UserProfile>, next: NextFunction) => {
    try {
      const targetId = req.params.id;
      const { role: newRole } = req.body as { role: UserRole };
      const actorId = req.auth!.userId!;

      if (targetId === actorId) {
        res.status(409).json({
          error: {
            code: 'SELF_ROLE_CHANGE_NOT_ALLOWED',
            message: 'Admins cannot change their own role',
          },
        } as unknown as UserProfile);
        return;
      }

      const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (!target) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'User not found' },
        } as unknown as UserProfile);
        return;
      }

      if (target.role === 'admin' && newRole !== 'admin') {
        const [{ value: adminCount }] = await db
          .select({ value: count() })
          .from(users)
          .where(eq(users.role, 'admin'));
        if (Number(adminCount) <= 1) {
          res.status(409).json({
            error: {
              code: 'LAST_ADMIN_CANNOT_BE_DEMOTED',
              message: 'Cannot demote the last remaining admin',
            },
          } as unknown as UserProfile);
          return;
        }
      }

      const [updated] = await db
        .update(users)
        .set({ role: newRole })
        .where(eq(users.id, targetId))
        .returning();

      await writeAuditLog(actorId, 'user.role_updated', 'user', targetId);

      res.json(serializeUser(updated));
    } catch (err) {
      next(err);
    }
  }
);
