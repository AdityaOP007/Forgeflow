import { beforeEach, afterAll } from 'vitest';
import { db, pool } from '../src/db/client.js';
import { users, auditLogs, workflowRuns, environments, services } from '../src/db/schema.js';
import { createApp } from '../src/app.js';
import type { AuthVerifier } from '../src/middleware/types.js';

export let testUsers: {
  viewer: typeof users.$inferSelect;
  devOwner: typeof users.$inferSelect;
  otherDev: typeof users.$inferSelect;
  admin: typeof users.$inferSelect;
};

export const testAuthVerifier: AuthVerifier = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token === 'viewer-token') {
    req.auth = {
      clerkId: testUsers.viewer.clerk_id,
      userId: testUsers.viewer.id,
      email: testUsers.viewer.email,
      name: testUsers.viewer.name,
      role: 'viewer',
    };
    return next();
  }
  if (token === 'dev-owner-token') {
    req.auth = {
      clerkId: testUsers.devOwner.clerk_id,
      userId: testUsers.devOwner.id,
      email: testUsers.devOwner.email,
      name: testUsers.devOwner.name,
      role: 'developer',
    };
    return next();
  }
  if (token === 'other-dev-token') {
    req.auth = {
      clerkId: testUsers.otherDev.clerk_id,
      userId: testUsers.otherDev.id,
      email: testUsers.otherDev.email,
      name: testUsers.otherDev.name,
      role: 'developer',
    };
    return next();
  }
  if (token === 'admin-token') {
    req.auth = {
      clerkId: testUsers.admin.clerk_id,
      userId: testUsers.admin.id,
      email: testUsers.admin.email,
      name: testUsers.admin.name,
      role: 'admin',
    };
    return next();
  }
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid session token' } });
};

export const app = createApp({ auth: testAuthVerifier });

export async function cleanTables() {
  const result = await pool.query('SELECT current_database() as db_name');
  const dbName: string | undefined = result.rows[0]?.db_name;
  if (!dbName || !dbName.endsWith('_test')) {
    throw new Error(
      `Safety guard: Refusing to clean tables because connected database '${dbName}' does not end with '_test'`
    );
  }
  await db.delete(auditLogs);
  await db.delete(workflowRuns);
  await db.delete(environments);
  await db.delete(services);
  await db.delete(users);
}

export async function seedUsers() {
  const [viewer] = await db
    .insert(users)
    .values({
      clerk_id: 'clerk_viewer_1',
      email: 'viewer@test.local',
      name: 'Viewer User',
      role: 'viewer',
    })
    .returning();

  const [devOwner] = await db
    .insert(users)
    .values({
      clerk_id: 'clerk_dev_owner_1',
      email: 'dev-owner@test.local',
      name: 'Dev Owner User',
      role: 'developer',
    })
    .returning();

  const [otherDev] = await db
    .insert(users)
    .values({
      clerk_id: 'clerk_other_dev_1',
      email: 'other-dev@test.local',
      name: 'Other Dev User',
      role: 'developer',
    })
    .returning();

  const [admin] = await db
    .insert(users)
    .values({
      clerk_id: 'clerk_admin_1',
      email: 'admin@test.local',
      name: 'Admin User',
      role: 'admin',
    })
    .returning();

  testUsers = { viewer, devOwner, otherDev, admin };
}

export async function getReferenceTemplateId() {
  const row = await db.query.templates.findFirst();
  return row ? row.id : null;
}

beforeEach(async () => {
  await cleanTables();
  await seedUsers();
});

afterAll(async () => {
  await cleanTables();
  await pool.end();
});
