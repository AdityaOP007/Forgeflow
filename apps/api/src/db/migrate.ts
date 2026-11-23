import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';
import path from 'path';
import { fileURLToPath } from 'url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(customDb?: NodePgDatabase<typeof schema>) {
  const targetDb = customDb || db;
  const migrationsFolder = path.resolve(__dirname, 'migrations');
  console.log(`Running migrations from ${migrationsFolder}...`);
  await migrate(targetDb, { migrationsFolder });
  console.log('Migrations completed successfully.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await pool.end();
      process.exit(1);
    });
}
