import type { Request, Response, NextFunction } from 'express';
import { verifyToken as clerkVerifyToken, createClerkClient } from '@clerk/express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getEnv, parseAdminEmails } from '../config/env.js';
import type { AuthVerifier } from './types.js';

export interface ClerkUserProfile {
  clerkId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface ClerkAuthDeps {
  verifySessionToken?: (token: string) => Promise<{ sub: string }>;
  fetchClerkUser?: (clerkId: string) => Promise<ClerkUserProfile>;
  ttlMs?: number;
  maxCacheSize?: number;
  now?: () => number;
}

class ClerkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClerkUnavailableError';
  }
}

class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

function isInvalidTokenClerkError(err: unknown): boolean {
  const e = err as { reason?: string; status?: number; message?: string; code?: string };
  if (e?.status && e.status >= 500) return false;
  const msg = (e?.message || '').toLowerCase();
  const reason = (e?.reason || '').toLowerCase();
  if (
    reason.includes('token-expired') ||
    reason.includes('token-invalid') ||
    reason.includes('token-not-active') ||
    reason.includes('signature') ||
    msg.includes('jwt') ||
    msg.includes('expired') ||
    msg.includes('invalid token') ||
    msg.includes('malformed')
  ) {
    return true;
  }
  return false;
}

export function createClerkAuthVerifier(deps: ClerkAuthDeps = {}): AuthVerifier {
  const ttlMs = deps.ttlMs ?? 5 * 60 * 1000;
  const maxCacheSize = deps.maxCacheSize ?? 1000;
  const now = deps.now ?? (() => Date.now());

  const userCache = new Map<string, { profile: ClerkUserProfile; expiresAt: number }>();
  const inFlight = new Map<string, Promise<ClerkUserProfile>>();

  let defaultClerkClient: ReturnType<typeof createClerkClient> | null = null;
  const getClerkClient = () => {
    if (!defaultClerkClient) {
      const env = getEnv();
      defaultClerkClient = createClerkClient({ secretKey: env.CLERK_SECRET_KEY! });
    }
    return defaultClerkClient;
  };

  const verifySessionToken =
    deps.verifySessionToken ??
    (async (token: string): Promise<{ sub: string }> => {
      const env = getEnv();
      try {
        const verified = await clerkVerifyToken(token, { secretKey: env.CLERK_SECRET_KEY! });
        if (!verified || typeof verified.sub !== 'string' || !verified.sub) {
          throw new InvalidTokenError('Invalid session token');
        }
        return { sub: verified.sub };
      } catch (err) {
        if (err instanceof InvalidTokenError) throw err;
        if (isInvalidTokenClerkError(err)) {
          throw new InvalidTokenError('Invalid or expired session token');
        }
        throw new ClerkUnavailableError('Authentication service temporarily unavailable');
      }
    });

  const fetchClerkUserRaw =
    deps.fetchClerkUser ??
    (async (clerkId: string): Promise<ClerkUserProfile> => {
      try {
        const client = getClerkClient();
        const u = await client.users.getUser(clerkId);
        const primary =
          u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ?? u.emailAddresses[0];
        if (!primary || !primary.emailAddress) {
          throw new InvalidTokenError('User account has no primary email address');
        }
        const email = primary.emailAddress.trim().toLowerCase();
        const emailVerified = primary.verification?.status === 'verified';
        const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
        const name = fullName || u.username || email;
        return { clerkId, email, emailVerified, name };
      } catch (err) {
        if (err instanceof InvalidTokenError) throw err;
        const status = (err as { status?: number })?.status;
        if (status === 404) {
          throw new InvalidTokenError('User not found in Clerk');
        }
        throw new ClerkUnavailableError('Authentication service temporarily unavailable');
      }
    });

  const getClerkUserCached = async (clerkId: string): Promise<ClerkUserProfile> => {
    const t = now();
    const cached = userCache.get(clerkId);
    if (cached && cached.expiresAt > t) {
      return cached.profile;
    }
    userCache.delete(clerkId);

    const existingPromise = inFlight.get(clerkId);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = (async () => {
      try {
        const profile = await fetchClerkUserRaw(clerkId);
        if (userCache.size >= maxCacheSize) {
          const oldestKey = userCache.keys().next().value;
          if (oldestKey !== undefined) {
            userCache.delete(oldestKey);
          }
        }
        userCache.set(clerkId, { profile, expiresAt: now() + ttlMs });
        return profile;
      } finally {
        inFlight.delete(clerkId);
      }
    })();

    inFlight.set(clerkId, promise);
    return promise;
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    let clerkId: string;
    try {
      const verified = await verifySessionToken(token);
      clerkId = verified.sub;
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: err.message },
        });
        return;
      }
      res.status(503).json({
        error: {
          code: 'AUTH_UNAVAILABLE',
          message: 'Authentication service temporarily unavailable',
        },
      });
      return;
    }

    let profile: ClerkUserProfile;
    try {
      profile = await getClerkUserCached(clerkId);
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: err.message },
        });
        return;
      }
      res.status(503).json({
        error: {
          code: 'AUTH_UNAVAILABLE',
          message: 'Authentication service temporarily unavailable',
        },
      });
      return;
    }

    const normalizedEmail = profile.email.trim().toLowerCase();
    const adminEmails = parseAdminEmails(getEnv().ADMIN_EMAILS);
    const shouldPromoteToAdmin = profile.emailVerified && adminEmails.has(normalizedEmail);

    try {
      const [existingByEmail] = await db
        .select({ id: users.id, clerk_id: users.clerk_id })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      if (existingByEmail && existingByEmail.clerk_id !== clerkId) {
        res.status(409).json({
          error: {
            code: 'EMAIL_CONFLICT',
            message: 'Email address already belongs to another account',
          },
        });
        return;
      }

      const [user] = await db
        .insert(users)
        .values({
          clerk_id: clerkId,
          email: normalizedEmail,
          name: profile.name,
          role: shouldPromoteToAdmin ? 'admin' : 'viewer',
        })
        .onConflictDoUpdate({
          target: users.clerk_id,
          set: {
            email: normalizedEmail,
            name: profile.name,
            role: shouldPromoteToAdmin ? 'admin' : sql`${users.role}`,
          },
        })
        .returning();

      req.auth = {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        clerkId: user.clerk_id,
      };
      next();
    } catch (err) {
      const pgCode =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (pgCode === '23505') {
        res.status(409).json({
          error: {
            code: 'EMAIL_CONFLICT',
            message: 'Email address already belongs to another account',
          },
        });
        return;
      }
      next(err);
    }
  };
}
