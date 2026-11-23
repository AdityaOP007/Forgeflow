import { pool } from './client.js';
import { runMigrations } from './migrate.js';
import { fileURLToPath } from 'url';

export async function resetDatabase() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset is strictly prohibited in production environments!');
  }

  console.log('Resetting local database (dropping and recreating public schema)...');
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('Public schema reset.');
  } finally {
    client.release();
  }

  await runMigrations();
  console.log('Database reset complete.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  resetDatabase()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Reset failed:', err);
      await pool.end();
      process.exit(1);
    });
}

