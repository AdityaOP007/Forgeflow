import type { Request, Response, NextFunction } from 'express';
import { getEnv } from '../config/env.js';

/**
 * Global error handler. Returns a consistent { error } shape.
 * Stack traces are only included in development mode.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const env = getEnv();
  const isDev = env.NODE_ENV === 'development';

  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (isDev) console.error(err.stack);

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: isDev ? err.message : 'An unexpected error occurred',
    },
  });
}

