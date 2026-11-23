import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { healthRouter } from './routes/health.js';
import { meRouter } from './modules/me/routes.js';
import { templatesRouter } from './modules/templates/routes.js';
import { servicesRouter } from './modules/services/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import type { AuthVerifier } from './middleware/types.js';

export interface AppOptions {
  auth: AuthVerifier;
  webOrigin?: string;
}

export function createApp({ auth, webOrigin }: AppOptions) {
  const app = express();

  // Security hardening
  app.use(helmet());

  // CORS limited to web origin
  const origin = webOrigin || process.env.WEB_ORIGIN || 'http://localhost:5173';
  app.use(
    cors({
      origin,
      credentials: true,
    })
  );

  // JSON body parser with size limit
  app.use(express.json({ limit: '100kb' }));

  // Rate limiting on /api routes
  const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    },
  });

  // Public routes (no auth)
  app.use(healthRouter);

  // Authenticated API routes
  const apiRouter = express.Router();
  apiRouter.use(limiter);
  apiRouter.use(auth);
  apiRouter.use('/me', meRouter);
  apiRouter.use('/templates', templatesRouter);
  apiRouter.use('/services', servicesRouter);
  apiRouter.use('/dashboard', dashboardRouter);

  app.use('/api', apiRouter);

  // Global error handler
  app.use(errorHandler);

  return app;
}
