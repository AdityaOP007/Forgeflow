import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '@forgeflow/shared-types';

/**
 * Middleware factory that enforces the user has one of the allowed roles.
 * Must be used after the auth middleware has set req.auth.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth?.role) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `Role '${req.auth.role}' is not allowed. Required: ${allowedRoles.join(', ')}`,
        },
      });
      return;
    }

    next();
  };
}
