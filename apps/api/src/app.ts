import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { loadEnv } from './config/env.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './modules/me/routes.js';
import { templatesRouter } from './modules/templates/routes.js';
import { createServicesRouter, type ServicesRouterOptions } from './modules/services/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import {
  createIntegrationsRouter,
  type IntegrationsRouterOptions,
} from './modules/integrations/routes.js';
import { workflowsRouter } from './modules/workflows/routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import type { AuthVerifier } from './middleware/types.js';

export interface AppOptions {
  auth: AuthVerifier;
  webOrigin?: string;
  integrations?: IntegrationsRouterOptions;
  services?: ServicesRouterOptions;
}

export function createApp({ auth, webOrigin, integrations, services }: AppOptions) {
  loadEnv();
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
  apiRouter.use('/services', createServicesRouter(services));
  apiRouter.use('/workflows', workflowsRouter);
  apiRouter.use('/dashboard', dashboardRouter);
  apiRouter.use('/integrations', createIntegrationsRouter(integrations));

  app.use('/api', apiRouter);

  // Global error handler
  app.use(errorHandler);

  return app;
}
