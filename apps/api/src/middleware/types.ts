import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '@forgeflow/shared-types';

// Injected auth identity attached by middleware
export interface AuthUser {
  clerkId: string;
  email: string;
  name: string | null;
  // DB-resolved fields (populated after upsert)
  userId?: string;
  role?: UserRole;
}

// Extend Express Request
/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

// The auth verifier function type — injectable for testing
export type AuthVerifier = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
