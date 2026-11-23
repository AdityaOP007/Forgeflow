import type { Request, Response, NextFunction } from 'express';
import { getEnv } from '../config/env.js';

/**
 * Global error handler. Returns a consistent { error } shape.
 * Honors custom status codes and error codes attached to Error objects.
 * Stack traces are only included in development mode for 500s.
 */
export function errorHandler(
  err: Error & { statusCode?: number; status?: number; code?: string },
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const env = getEnv();
  const isDev = env.NODE_ENV === 'development';
  const statusCode = err.statusCode || err.status || 500;
  const errorCode =
    err.code ||
    (statusCode === 503
      ? 'SERVICE_UNAVAILABLE'
      : statusCode === 409
        ? 'CONFLICT'
        : statusCode === 400
          ? 'BAD_REQUEST'
          : statusCode === 401
            ? 'UNAUTHORIZED'
            : statusCode === 403
              ? 'FORBIDDEN'
              : statusCode === 404
                ? 'NOT_FOUND'
                : 'INTERNAL_SERVER_ERROR');

  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (isDev && statusCode === 500) console.error(err.stack);

  res.status(statusCode).json({
    error: {
      code: errorCode,
      message: statusCode === 500 && !isDev ? 'An unexpected error occurred' : err.message,
    },
  });
}
