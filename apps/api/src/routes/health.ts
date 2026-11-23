import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HealthResponse, ReadyResponse } from '@forgeflow/shared-types';
import { pool } from '../db/client.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req: Request, res: Response<HealthResponse>) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/health/ready', async (_req: Request, res: Response<ReadyResponse>) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    res.json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'disconnected' });
  }
});
