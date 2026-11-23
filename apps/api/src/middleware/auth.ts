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

let cachedLocalUser: typeof users.$inferSelect | null = null;
let inFlightLocalUserPromise: Promise<typeof users.$inferSelect> | null = null;

export function resetLocalUserCache(): void {
  cachedLocalUser = null;
  inFlightLocalUserPromise = null;
}

/**
 * Atomically upsert the single local admin user into the users table.
 * Caches the resolved user row in memory so subsequent requests hit memory, not the database.
 * Handles concurrent requests safely via single-flight deduplication.
 */
export async function getOrCreateLocalUser(): Promise<typeof users.$inferSelect> {
  if (cachedLocalUser) {
    return cachedLocalUser;
  }
  if (inFlightLocalUserPromise) {
    return inFlightLocalUserPromise;
  }

  inFlightLocalUserPromise = (async () => {
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

    cachedLocalUser = user;
    return user;
  })();

  try {
    return await inFlightLocalUserPromise;
  } finally {
    inFlightLocalUserPromise = null;
  }
}

/**
 * Local development auth verifier.
 * Runs ForgeFlow as a single built-in local admin user and completely ignores
 * any incoming Authorization header.
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
