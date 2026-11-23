import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

export function createDbPool(connectionString?: string) {
  const url =
    connectionString ||
    process.env.DATABASE_URL ||
    'postgresql://forgeflow:forgeflow_password@localhost:5432/forgeflow';
  return new Pool({ connectionString: url });
}

export function createDbClient(poolInstance?: pg.Pool) {
  const p = poolInstance || createDbPool();
  return drizzle(p, { schema });
}

export const pool = createDbPool();
export const db = createDbClient(pool);

