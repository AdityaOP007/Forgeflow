import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';

export function createApp() {
  const app = express();

  const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:5173';

  app.use(
    cors({
      origin: webOrigin,
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(healthRouter);

  return app;
}

