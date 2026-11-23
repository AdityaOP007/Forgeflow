import { clerkMiddleware, getAuth } from '@clerk/express';
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getEnv } from '../config/env.js';
import type { AuthVerifier } from './types.js';

const clerkInstance = clerkMiddleware();

/**
 * Production auth verifier using Clerk.
 * Verifies the session token, upserts the user row, and
 * promotes matching ADMIN_EMAILS to admin.
 */
export const clerkAuthVerifier: AuthVerifier = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  clerkInstance(req, res, async (err?: unknown) => {
    if (err) return next(err);

    try {
      const auth = getAuth(req);
      if (!auth?.userId) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
        return;
      }

      const clerkId = auth.userId;

      // Fetch user info from Clerk session claims
      const claims = auth.sessionClaims as Record<string, unknown> | undefined;
      const email =
        (claims?.email as string) ||
        (claims?.primary_email_address as string) ||
        `${clerkId}@users.forgeflow.local`;

      const name =
        (claims?.name as string) ||
        (claims?.full_name as string) ||
        `${(claims?.first_name as string) || ''} ${(claims?.last_name as string) || ''}`.trim() ||
        null;

      // Upsert user
      const env = getEnv();
      const isAdmin = env.ADMIN_EMAILS.includes(email);
      const targetRole = isAdmin ? 'admin' : undefined;

      const existing = await db.query.users.findFirst({
        where: eq(users.clerk_id, clerkId),
      });

      let dbUser;
      if (existing) {
        const updateData: Record<string, unknown> = { name, email };
        if (targetRole) updateData.role = targetRole;
        const [updated] = await db
          .update(users)
          .set(updateData)
          .where(eq(users.clerk_id, clerkId))
          .returning();
        dbUser = updated;
      } else {
        const [inserted] = await db
          .insert(users)
          .values({
            clerk_id: clerkId,
            email,
            name,
            role: targetRole || 'viewer',
          })
          .returning();
        dbUser = inserted;
      }

      req.auth = {
        clerkId,
        email,
        name,
        userId: dbUser.id,
        role: dbUser.role,
      };

      next();
    } catch (error) {
      next(error);
    }
  });
};
