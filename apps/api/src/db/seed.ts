import { db, pool } from './client.js';
import { templates } from './schema.js';
import { fileURLToPath } from 'url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema.js';

export async function seed(customDb?: NodePgDatabase<typeof schema>) {
  const targetDb = customDb || db;
  console.log('Seeding reference templates...');

  const templateData = [
    {
      name: 'Node.js + Express Service',
      slug: 'node-express',
      language: 'typescript',
      framework: 'express',
      version: '1.0.0',
      source_location: 'templates/node-service',
    },
    {
      name: 'Python + FastAPI Service',
      slug: 'python-fastapi',
      language: 'python',
      framework: 'fastapi',
      version: '1.1.0',
      source_location: 'templates/fastapi-service',
    },
  ];

  for (const tpl of templateData) {
    await targetDb
      .insert(templates)
      .values(tpl)
      .onConflictDoUpdate({
        target: templates.slug,
        set: {
          name: tpl.name,
          language: tpl.language,
          framework: tpl.framework,
          version: tpl.version,
          source_location: tpl.source_location,
        },
      });
  }

  console.log('Templates seeded successfully.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Seed failed:', err);
      await pool.end();
      process.exit(1);
    });
}
