import { createDbPool, createDbClient } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

export async function setup() {
  const testUrl =
    process.env.TEST_DATABASE_URL ||
    'postgresql://forgeflow:forgeflow_password@localhost:5432/forgeflow_test';
  const testPool = createDbPool(testUrl);
  const testDb = createDbClient(testPool);

  console.log('[test globalSetup] Running migrations on forgeflow_test...');
  await runMigrations(testDb);
  console.log('[test globalSetup] Seeding reference templates on forgeflow_test...');
  await seed(testDb);

  await testPool.end();
}
