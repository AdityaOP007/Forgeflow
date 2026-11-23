import { clerkMiddleware, getAuth, clerkClient } from '@clerk/express';
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getEnv } from '../config/env.js';
import type { AuthVerifier } from './types.js';

const clerkInstance = clerkMiddleware();

export interface ClerkUserLike {
  id: string;
  primaryEmailAddressId: string | null;
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification?: { status?: string | null } | null;
  }>;
  firstName?: string | null;
  lastName?: string | null;
}

export type ClerkUserLookup = (userId: string) => Promise<ClerkUserLike>;

export interface ProvisionUserParams {
  clerkId: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

// ─── In-Memory TTL Cache & Singleflight Map ───────────────────────────
interface CacheEntry {
  syncedAt: number;
}

const SYNC_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 1000;

const syncCache = new Map<string, CacheEntry>();
const inFlightSyncs = new Map<string, Promise<typeof users.$inferSelect>>();

export function clearSyncCache(): void {
  syncCache.clear();
  inFlightSyncs.clear();
}

function recordSync(clerkId: string): void {
  if (syncCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = syncCache.keys().next().value;
    if (oldestKey !== undefined) {
      syncCache.delete(oldestKey);
    }
  }
  syncCache.set(clerkId, { syncedAt: Date.now() });
}

/**
 * Provision or sync user in the database.
 * Uses atomic insert ... on conflict (clerk_id) do update.
 * Normalizes email by lowercasing and trimming on both sides.
 * Rejects with 409 if email is already taken by a different clerk_id.
 * Only elevates role to admin when verified (no demotion).
 */
export async function provisionUser(params: ProvisionUserParams) {
  const env = getEnv();
  const normalizedEmail = params.email.trim().toLowerCase();
  const adminEmails = env.ADMIN_EMAILS.map((e) => e.trim().toLowerCase());

  // Check if email already belongs to a different clerk_id
  const existingWithEmail = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  });

  if (existingWithEmail && existingWithEmail.clerk_id !== params.clerkId) {
    const err = new Error(`Email '${normalizedEmail}' is already associated with another account`);
    (err as Error & { statusCode: number; code?: string }).statusCode = 409;
    (err as Error & { statusCode: number; code?: string }).code = 'CONFLICT';
    throw err;
  }

  // Admin evaluation: requires verified primary email AND presence in ADMIN_EMAILS
  const isAdmin = params.emailVerified === true && adminEmails.includes(normalizedEmail);

  // Construct atomic insert with on conflict do update
  const updateSet: Record<string, unknown> = {
    email: normalizedEmail,
    name: params.name,
  };

  if (isAdmin) {
    updateSet.role = 'admin';
  }

  try {
    const [user] = await db
      .insert(users)
      .values({
        clerk_id: params.clerkId,
        email: normalizedEmail,
        name: params.name,
        role: isAdmin ? 'admin' : 'viewer',
      })
      .onConflictDoUpdate({
        target: users.clerk_id,
        set: updateSet,
      })
      .returning();

    return user;
  } catch (dbErr: unknown) {
    // Catch unique constraint violation on email in case of concurrent insert race
    if (dbErr && typeof dbErr === 'object' && 'code' in dbErr && dbErr.code === '23505') {
      const err = new Error(
        `Email '${normalizedEmail}' is already associated with another account`
      );
      (err as Error & { statusCode: number; code?: string }).statusCode = 409;
      (err as Error & { statusCode: number; code?: string }).code = 'CONFLICT';
      throw err;
    }
    throw dbErr;
  }
}

/**
 * Look up Clerk user via clerkClient, extract primary email and verification status,
 * and call provisionUser.
 *
 * Calls clerkClient.users.getUser only when:
 * 1. There is no users row for the clerk_id in the database, OR
 * 2. The cached sync is older than 5 minutes (TTL).
 *
 * Concurrent requests for the same clerk_id share one in-flight lookup.
 * If the Clerk lookup fails, returns 503 { error: { code: 'SERVICE_UNAVAILABLE' } } and never 500.
 */
export async function syncClerkUser(
  userId: string,
  lookupUser: ClerkUserLookup = (id) => clerkClient.users.getUser(id)
) {
  // Deduplicate concurrent in-flight syncs for the same user (singleflight pattern)
  const existingSync = inFlightSyncs.get(userId);
  if (existingSync) {
    return existingSync;
  }

  const syncPromise = (async () => {
    // Check if user already exists in DB
    const existingUser = await db.query.users.findFirst({
      where: eq(users.clerk_id, userId),
    });

    const cached = syncCache.get(userId);
    const now = Date.now();
    const isCacheFresh = cached !== undefined && now - cached.syncedAt < SYNC_TTL_MS;

    // Return existing user without calling Clerk if user exists and sync is fresh within 5 minutes
    if (existingUser && isCacheFresh) {
      return existingUser;
    }

    let clerkUser: ClerkUserLike;
    try {
      clerkUser = await lookupUser(userId);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'statusCode' in err &&
        (err as { statusCode: number }).statusCode === 503
      ) {
        throw err;
      }
      const serviceErr = new Error('Authentication service temporarily unavailable');
      (serviceErr as Error & { statusCode: number; code?: string }).statusCode = 503;
      (serviceErr as Error & { statusCode: number; code?: string }).code = 'SERVICE_UNAVAILABLE';
      throw serviceErr;
    }

    const primaryEmailObj = clerkUser.emailAddresses?.find(
      (e) => e.id === clerkUser.primaryEmailAddressId
    );

    if (!primaryEmailObj) {
      const err = new Error('No primary email address found for this Clerk user');
      (err as Error & { statusCode: number; code?: string }).statusCode = 400;
      (err as Error & { statusCode: number; code?: string }).code = 'BAD_REQUEST';
      throw err;
    }

    const isVerified = primaryEmailObj.verification?.status === 'verified';
    const name = `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() || null;

    const user = await provisionUser({
      clerkId: clerkUser.id,
      email: primaryEmailObj.emailAddress,
      name,
      emailVerified: isVerified,
    });

    // Record successful sync in cache
    recordSync(clerkUser.id);

    return user;
  })();

  inFlightSyncs.set(userId, syncPromise);
  try {
    return await syncPromise;
  } finally {
    inFlightSyncs.delete(userId);
  }
}

/**
 * Production auth verifier using Clerk.
 * Verifies the session token via clerkMiddleware, fetches user from Clerk API,
 * and syncs user via syncClerkUser. Strictly accepts only verified Clerk tokens.
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

      const dbUser = await syncClerkUser(auth.userId);

      req.auth = {
        clerkId: auth.userId,
        email: dbUser.email,
        name: dbUser.name,
        userId: dbUser.id,
        role: dbUser.role,
      };

      next();
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        ('statusCode' in error || 'code' in error) &&
        ((error as { statusCode?: number }).statusCode === 503 ||
          (error as { code?: string }).code === 'SERVICE_UNAVAILABLE')
      ) {
        res.status(503).json({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message:
              (error as { message?: string }).message ||
              'Authentication service temporarily unavailable',
          },
        });
        return;
      }
      next(error);
    }
  });
};
