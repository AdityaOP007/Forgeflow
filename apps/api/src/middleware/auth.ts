import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getEnv } from '../config/env.js';
import type { AuthVerifier } from './types.js';

/**
 * Note: 'clerk_id' is an external-auth identity placeholder column preserved for
 * future enterprise authentication integrations.
 */
export const LOCAL_ADMIN_CLERK_ID = 'local-admin';

/**
 * Atomically upsert the single local admin user into the users table and return the row.
 * Each request performs one atomic upsert (insert ... on conflict (clerk_id) do update).
 */
export async function getOrCreateLocalUser(): Promise<typeof users.$inferSelect> {
  const env = getEnv();
  const email = (env.LOCAL_USER_EMAIL || 'admin@forgeflow.local').trim().toLowerCase();
  const name = 'Local Admin';

  const [user] = await db
    .insert(users)
    .values({
      clerk_id: LOCAL_ADMIN_CLERK_ID,
      email,
      name,
      role: 'admin',
    })
    .onConflictDoUpdate({
      target: users.clerk_id,
      set: {
        email,
        name,
        role: 'admin',
      },
    })
    .returning();

  return user;
}

/**
 * Local development auth verifier.
 * Runs ForgeFlow as a single built-in local admin user and completely ignores
 * any incoming Authorization header.
 * Each request performs one atomic upsert and uses the returned row.
 */
export const localUserAuthVerifier: AuthVerifier = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await getOrCreateLocalUser();
    req.auth = {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      clerkId: user.clerk_id,
    };
    next();
  } catch (error) {
    next(error);
  }
};
