import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HealthResponse } from '@forgeflow/shared-types';

export const healthRouter = Router();

healthRouter.get('/health', (_req: Request, res: Response<HealthResponse>) => {
  res.json({ status: 'ok' });
});

