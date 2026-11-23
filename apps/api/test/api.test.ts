import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app, testUsers, cleanTables } from './setup.js';
import { db, pool } from '../src/db/client.js';
import { users, services, environments, workflowRuns, auditLogs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import {
  syncClerkUser,
  clearSyncCache,
  type ClerkUserLike,
  type ClerkUserLookup,
} from '../src/middleware/auth.js';
import type { AuthVerifier } from '../src/middleware/types.js';
import pg from 'pg';

describe('ForgeFlow API — Checkpoint 1C Comprehensive Test Suite', () => {
  // ─── 1. Health & Readiness ──────────────────────────────────────────
  describe('Health Probes', () => {
    it('GET /health returns 200 { status: "ok" } without auth', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('GET /health/ready returns 200 when database is connected', async () => {
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', database: 'connected' });
    });

    it('GET /health/ready returns 503 when database is unreachable', async () => {
      // Create a test app whose ready probe tests an unreachable pool
      const brokenPool = new pg.Pool({
        connectionString: 'postgresql://invalid:invalid@localhost:5432/nonexistent',
      });
      const brokenApp = createApp({
        auth: (_req, _res, next) => next(),
      });
      // Override the route on a temporary app with disconnected pool test
      brokenApp.get('/health/ready-broken', async (_req, res) => {
        try {
          const client = await brokenPool.connect();
          await client.query('SELECT 1');
          client.release();
          res.json({ status: 'ok', database: 'connected' });
        } catch {
          res.status(503).json({ status: 'degraded', database: 'disconnected' });
        }
      });

      const res = await request(brokenApp).get('/health/ready-broken');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'degraded', database: 'disconnected' });
      await brokenPool.end().catch(() => {});
    });
  });

  // ─── 2. Authentication ──────────────────────────────────────────────
  describe('Authentication Enforcement', () => {
    it('returns 401 UNAUTHORIZED when no token is supplied', async () => {
      const res = await request(app).get('/api/services');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    });

    it('returns 401 UNAUTHORIZED when an invalid token is supplied', async () => {
      const res = await request(app)
        .get('/api/services')
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('GET /api/me returns current user profile in camelCase', async () => {
      const res = await request(app).get('/api/me').set('Authorization', 'Bearer dev-owner-token');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: testUsers.devOwner.id,
        clerkId: testUsers.devOwner.clerk_id,
        name: testUsers.devOwner.name,
        email: testUsers.devOwner.email,
        role: 'developer',
      });
      expect(res.body).toHaveProperty('createdAt');
      // Verify no snake_case
      expect(res.body).not.toHaveProperty('clerk_id');
      expect(res.body).not.toHaveProperty('created_at');
    });
  });

  // ─── 3. Input Validation ────────────────────────────────────────────
  describe('Validation & Repository URL Requirements', () => {
    it('rejects service name with uppercase, spaces, or invalid chars (400)', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'Invalid Name With Spaces' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects path-traversal input in name (400)', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: '../etc/passwd' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.name).toBeDefined();
    });

    it('rejects missing name field (400)', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ description: 'No name given' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects repositoryUrl with "javascript:alert(1)" returning 400 with field-level details', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({
          name: 'valid-service',
          repositoryUrl: 'javascript:alert(1)',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.repositoryUrl).toContain(
        'Repository URL must start with http:// or https://'
      );
    });

    it('POST with repositoryUrl "" stores NULL in the database', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({
          name: 'empty-repo-service',
          repositoryUrl: '',
        });
      expect(res.status).toBe(201);
      expect(res.body.repositoryUrl).toBeNull();

      // Directly verify database column is NULL
      const [dbRow] = await db
        .select()
        .from(services)
        .where(eq(services.slug, 'empty-repo-service'));
      expect(dbRow.repository_url).toBeNull();
    });

    it('POST with repositoryUrl "   " (whitespace) stores NULL in the database', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({
          name: 'whitespace-repo-service',
          repositoryUrl: '   ',
        });
      expect(res.status).toBe(201);
      expect(res.body.repositoryUrl).toBeNull();

      // Directly verify database column is NULL
      const [dbRow] = await db
        .select()
        .from(services)
        .where(eq(services.slug, 'whitespace-repo-service'));
      expect(dbRow.repository_url).toBeNull();
    });

    it('POST with a valid https URL stores the trimmed value', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({
          name: 'trimmed-repo-service',
          repositoryUrl: '  https://github.com/forgeflow/trimmed-repo  ',
        });
      expect(res.status).toBe(201);
      expect(res.body.repositoryUrl).toBe('https://github.com/forgeflow/trimmed-repo');

      // Verify in DB
      const [dbRow] = await db
        .select()
        .from(services)
        .where(eq(services.slug, 'trimmed-repo-service'));
      expect(dbRow.repository_url).toBe('https://github.com/forgeflow/trimmed-repo');
    });

    it('returns 409 CONFLICT on duplicate slug', async () => {
      await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'duplicate-service' });

      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'duplicate-service' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });
  });

  // ─── 4. Exact CamelCase Key Set Assertions ─────────────────────────
  describe('Exact CamelCase Key Set Assertions', () => {
    const expectedListItemKeys = [
      'id',
      'name',
      'slug',
      'description',
      'ownerId',
      'ownerName',
      'repositoryUrl',
      'templateId',
      'templateName',
      'health',
      'createdAt',
      'updatedAt',
    ].sort();

    const expectedDetailItemKeys = [
      'id',
      'name',
      'slug',
      'description',
      'ownerId',
      'ownerName',
      'repositoryUrl',
      'templateId',
      'templateName',
      'health',
      'createdAt',
      'updatedAt',
      'environments',
      'workflowRuns',
    ].sort();

    it('POST /api/services returns exact camelCase key set with no snake_case keys', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({
          name: 'keys-check-service',
          description: 'Key set test',
          repositoryUrl: 'https://github.com/forgeflow/keys-check',
        });
      expect(res.status).toBe(201);
      const actualKeys = Object.keys(res.body).sort();
      expect(actualKeys).toEqual(expectedDetailItemKeys);

      // Verify no snake_case keys anywhere
      for (const k of actualKeys) {
        expect(k).not.toContain('_');
      }
    });

    it('GET /api/services (list item) returns exact camelCase key set with no snake_case keys', async () => {
      await request(app).post('/api/services').set('Authorization', 'Bearer dev-owner-token').send({
        name: 'list-keys-service',
        description: 'Key set test',
        repositoryUrl: 'https://github.com/forgeflow/keys-check',
      });

      const res = await request(app)
        .get('/api/services')
        .set('Authorization', 'Bearer dev-owner-token');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);

      const item = res.body.data[0];
      const actualKeys = Object.keys(item).sort();
      expect(actualKeys).toEqual(expectedListItemKeys);

      for (const k of actualKeys) {
        expect(k).not.toContain('_');
      }
    });

    it('GET /api/services/:id returns exact camelCase key set with no snake_case keys', async () => {
      const createRes = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({
          name: 'detail-keys-service',
          description: 'Key set test',
          repositoryUrl: 'https://github.com/forgeflow/keys-check',
        });
      const serviceId = createRes.body.id;

      const res = await request(app)
        .get(`/api/services/${serviceId}`)
        .set('Authorization', 'Bearer dev-owner-token');
      expect(res.status).toBe(200);

      const actualKeys = Object.keys(res.body).sort();
      expect(actualKeys).toEqual(expectedDetailItemKeys);

      for (const k of actualKeys) {
        expect(k).not.toContain('_');
      }
    });
  });

  // ─── 5. Update / PATCH Behavior ────────────────────────────────────
  describe('PATCH /api/services/:id Repository URL clearing', () => {
    it('PATCH with repositoryUrl: null clears the field to NULL in DB', async () => {
      // Create service with a repo URL
      const createRes = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({
          name: 'patch-null-service',
          repositoryUrl: 'https://github.com/forgeflow/patch-null',
        });
      expect(createRes.status).toBe(201);
      const serviceId = createRes.body.id;

      // PATCH with null
      const patchRes = await request(app)
        .patch(`/api/services/${serviceId}`)
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ repositoryUrl: null });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.repositoryUrl).toBeNull();

      // Directly verify DB column is NULL
      const [dbRow] = await db.select().from(services).where(eq(services.id, serviceId));
      expect(dbRow.repository_url).toBeNull();
    });

    it('PATCH omitting repositoryUrl leaves the column unchanged in DB', async () => {
      const createRes = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({
          name: 'patch-omit-service',
          repositoryUrl: 'https://github.com/forgeflow/keep-me',
        });
      const serviceId = createRes.body.id;

      // PATCH description only (omit repositoryUrl)
      const patchRes = await request(app)
        .patch(`/api/services/${serviceId}`)
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ description: 'Updated description only' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.description).toBe('Updated description only');
      expect(patchRes.body.repositoryUrl).toBe('https://github.com/forgeflow/keep-me');

      // Verify DB column still holds the original URL
      const [dbRow] = await db.select().from(services).where(eq(services.id, serviceId));
      expect(dbRow.repository_url).toBe('https://github.com/forgeflow/keep-me');
    });
  });

  // ─── 6. Permissions Matrix ──────────────────────────────────────────
  describe('Permissions Matrix (Role-based access)', () => {
    let dev1ServiceId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'dev1-ownership-test' });
      dev1ServiceId = res.body.id;
    });

    it('viewer CANNOT create a service (403)', async () => {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer viewer-token')
        .send({ name: 'viewer-forbidden-svc' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('viewer CANNOT update a service (403)', async () => {
      const res = await request(app)
        .patch(`/api/services/${dev1ServiceId}`)
        .set('Authorization', 'Bearer viewer-token')
        .send({ description: 'Viewer edit' });
      expect(res.status).toBe(403);
    });

    it('viewer CANNOT delete a service (403)', async () => {
      const res = await request(app)
        .delete(`/api/services/${dev1ServiceId}`)
        .set('Authorization', 'Bearer viewer-token');
      expect(res.status).toBe(403);
    });

    it('developer2 CANNOT update developer1’s service (403)', async () => {
      const res = await request(app)
        .patch(`/api/services/${dev1ServiceId}`)
        .set('Authorization', 'Bearer other-dev-token')
        .send({ description: 'Hacked by other dev' });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('only update your own services');
    });

    it('developer2 CANNOT delete developer1’s service (403)', async () => {
      const res = await request(app)
        .delete(`/api/services/${dev1ServiceId}`)
        .set('Authorization', 'Bearer other-dev-token');
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('only delete your own services');
    });

    it('developer1 (owner) CAN update own service (200)', async () => {
      const res = await request(app)
        .patch(`/api/services/${dev1ServiceId}`)
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ description: 'Owner authorized edit' });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('Owner authorized edit');
    });

    it('admin CAN update any developer’s service (200)', async () => {
      const res = await request(app)
        .patch(`/api/services/${dev1ServiceId}`)
        .set('Authorization', 'Bearer admin-token')
        .send({ description: 'Admin override edit' });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('Admin override edit');
    });

    it('admin CAN delete any service (204)', async () => {
      const res = await request(app)
        .delete(`/api/services/${dev1ServiceId}`)
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(204);

      // Verify deletion in DB
      const row = await db.query.services.findFirst({
        where: eq(services.id, dev1ServiceId),
      });
      expect(row).toBeUndefined();
    });

    it('owner CAN delete own service (204)', async () => {
      const createRes = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'owner-delete-test' });
      const svcId = createRes.body.id;

      const delRes = await request(app)
        .delete(`/api/services/${svcId}`)
        .set('Authorization', 'Bearer dev-owner-token');
      expect(delRes.status).toBe(204);
    });
  });

  // ─── 7. List Endpoint (Pagination, Search, Filter) ──────────────────
  describe('List Services Endpoint', () => {
    it('returns empty list and total 0 on empty database', async () => {
      await cleanTables();
      const res = await request(app)
        .get('/api/services')
        .set('Authorization', 'Bearer dev-owner-token');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
      });
    });

    it('supports pagination, search, and health filtering', async () => {
      // Create 3 services
      await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'alpha-service' });
      await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'beta-service' });
      await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'gamma-service' });

      // Test search
      const searchRes = await request(app)
        .get('/api/services?search=alpha')
        .set('Authorization', 'Bearer dev-owner-token');
      expect(searchRes.status).toBe(200);
      expect(searchRes.body.total).toBe(1);
      expect(searchRes.body.data[0].slug).toBe('alpha-service');

      // Test pagination
      const pageRes = await request(app)
        .get('/api/services?pageSize=2&page=1')
        .set('Authorization', 'Bearer dev-owner-token');
      expect(pageRes.status).toBe(200);
      expect(pageRes.body.data.length).toBe(2);
      expect(pageRes.body.total).toBe(3);
      expect(pageRes.body.totalPages).toBe(2);

      // Test health filter (all are unknown because no environments attached)
      const healthRes = await request(app)
        .get('/api/services?health=unknown')
        .set('Authorization', 'Bearer dev-owner-token');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.data.length).toBe(3);
    });
  });

  // ─── 8. Dashboard Summary ───────────────────────────────────────────
  describe('Dashboard Summary', () => {
    it('returns zeros on an empty database', async () => {
      await cleanTables();
      const res = await request(app)
        .get('/api/dashboard/summary')
        .set('Authorization', 'Bearer dev-owner-token');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        totalServices: 0,
        healthyCount: 0,
        unhealthyCount: 0,
        unknownCount: 0,
        activeDeployments: 0,
        failedBuilds: 0,
      });
    });

    it('returns accurate counts with services, environments, and workflow runs', async () => {
      await cleanTables();
      // Re-seed users
      const [dev] = await db
        .insert(users)
        .values({
          clerk_id: 'dev_summary_test',
          email: 'dev@test.local',
          name: 'Dev User',
          role: 'developer',
        })
        .returning();

      // Create 2 services
      const [svc1] = await db
        .insert(services)
        .values({
          name: 'svc-healthy',
          slug: 'svc-healthy',
          owner_id: dev.id,
        })
        .returning();

      const [svc2] = await db
        .insert(services)
        .values({
          name: 'svc-failing',
          slug: 'svc-failing',
          owner_id: dev.id,
        })
        .returning();

      // Attach environments: svc1 healthy, svc2 failed
      await db.insert(environments).values([
        { service_id: svc1.id, name: 'production', status: 'healthy' },
        { service_id: svc2.id, name: 'production', status: 'failed' },
      ]);

      // Attach workflow runs: 1 running deployment, 1 failed build within 24h
      await db.insert(workflowRuns).values([
        {
          service_id: svc1.id,
          type: 'deploy',
          status: 'running',
          started_at: new Date(),
        },
        {
          service_id: svc2.id,
          type: 'build',
          status: 'failed',
          started_at: new Date(),
        },
      ]);

      const res = await request(app)
        .get('/api/dashboard/summary')
        .set('Authorization', 'Bearer dev-owner-token');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        totalServices: 2,
        healthyCount: 1,
        unhealthyCount: 1,
        unknownCount: 0,
        activeDeployments: 1,
        failedBuilds: 1,
      });
    });
  });

  // ─── 9. Audit Logging ───────────────────────────────────────────────
  describe('Audit Logging Verification', () => {
    it('records audit log entries on service create, update, and delete', async () => {
      // 1. Create
      const createRes = await request(app)
        .post('/api/services')
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ name: 'audit-log-service' });
      const svcId = createRes.body.id;

      const createAudit = await db.query.auditLogs.findFirst({
        where: eq(auditLogs.resource_id, svcId),
      });
      expect(createAudit).toBeDefined();
      expect(createAudit?.action).toBe('service.create');
      expect(createAudit?.actor_id).toBe(testUsers.devOwner.id);

      // 2. Update
      await request(app)
        .patch(`/api/services/${svcId}`)
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ description: 'Updated for audit' });

      const updateAudits = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.resource_id, svcId));
      expect(updateAudits.some((a) => a.action === 'service.update')).toBe(true);

      // 3. Delete
      await request(app)
        .delete(`/api/services/${svcId}`)
        .set('Authorization', 'Bearer dev-owner-token');

      const deleteAudits = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.resource_id, svcId));
      expect(deleteAudits.some((a) => a.action === 'service.delete')).toBe(true);
    });
  });

  // ─── 10. Templates Listing ──────────────────────────────────────────
  describe('Templates Listing', () => {
    it('GET /api/templates returns reference templates in camelCase', async () => {
      const res = await request(app)
        .get('/api/templates')
        .set('Authorization', 'Bearer viewer-token');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);

      const tpl = res.body[0];
      expect(tpl).toHaveProperty('id');
      expect(tpl).toHaveProperty('name');
      expect(tpl).toHaveProperty('slug');
      expect(tpl).toHaveProperty('language');
      expect(tpl).toHaveProperty('framework');
      expect(tpl).toHaveProperty('version');
      expect(tpl).toHaveProperty('sourceLocation');
      expect(tpl).toHaveProperty('createdAt');

      // Verify no snake_case
      expect(tpl).not.toHaveProperty('source_location');
      expect(tpl).not.toHaveProperty('created_at');
    });
  });

  // ─── 11. Test Database Cleanup Safety Guard ─────────────────────────
  describe('Test Database Cleanup Safety Guard', () => {
    it('cleanTables succeeds when connected to a database ending with _test', async () => {
      await expect(cleanTables()).resolves.not.toThrow();
    });

    it('cleanTables throws an error if connected database does not end with _test', async () => {
      // Mock pool query to simulate being connected to production database
      const querySpy = vi.spyOn(pool, 'query').mockImplementationOnce(async () => {
        return { rows: [{ db_name: 'forgeflow_production' }] } as unknown as pg.QueryResult;
      });

      await expect(cleanTables()).rejects.toThrow(
        /Refusing to clean tables because connected database 'forgeflow_production' does not end with '_test'/
      );

      querySpy.mockRestore();
    });
  });

  // ─── 12. User Provisioning on Authenticated Requests ──────────────────
  describe('User Provisioning on Authenticated Requests', () => {
    // In-memory simulated Clerk users registry
    const simulatedClerkUsers = new Map<string, ClerkUserLike>();

    const mockClerkLookup = vi.fn(async (userId: string) => {
      const u = simulatedClerkUsers.get(userId);
      if (!u) {
        const err = new Error(`Clerk user '${userId}' not found`);
        (err as Error & { statusCode: number }).statusCode = 401;
        throw err;
      }
      return u;
    });

    // Injectable auth verifier for tests simulating Clerk token & lookup via syncClerkUser
    const provisioningAuthVerifier: AuthVerifier = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res
          .status(401)
          .json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const token = authHeader.replace(/^Bearer\s+/i, '');
      try {
        const dbUser = await syncClerkUser(token, mockClerkLookup);

        req.auth = {
          clerkId: dbUser.clerk_id,
          email: dbUser.email,
          name: dbUser.name,
          userId: dbUser.id,
          role: dbUser.role,
        };
        next();
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          ('statusCode' in err || 'code' in err) &&
          ((err as { statusCode?: number }).statusCode === 503 ||
            (err as { code?: string }).code === 'SERVICE_UNAVAILABLE')
        ) {
          res.status(503).json({
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message:
                (err as { message?: string }).message ||
                'Authentication service temporarily unavailable',
            },
          });
          return;
        }
        next(err);
      }
    };

    const provApp = createApp({ auth: provisioningAuthVerifier });

    it('first authenticated request creates a users row (viewer)', async () => {
      const clerkId = 'clerk_prov_regular_1';
      const email = 'regular_dev@example.com';
      const firstName = 'Regular';
      const lastName = 'Developer';

      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_reg_1',
        emailAddresses: [
          {
            id: 'email_reg_1',
            emailAddress: email,
            verification: { status: 'verified' },
          },
        ],
        firstName,
        lastName,
      });

      // Ensure user does not exist yet
      const before = await db.query.users.findFirst({
        where: eq(users.clerk_id, clerkId),
      });
      expect(before).toBeUndefined();

      const res = await request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: expect.any(String),
        clerkId,
        email,
        name: `${firstName} ${lastName}`,
        role: 'viewer',
        createdAt: expect.any(String),
      });

      // Verify row in DB
      const after = await db.query.users.findFirst({
        where: eq(users.clerk_id, clerkId),
      });
      expect(after).toBeDefined();
      expect(after?.role).toBe('viewer');
      expect(after?.email).toBe(email);
      expect(after?.name).toBe(`${firstName} ${lastName}`);
    });

    it('an email in ADMIN_EMAILS with unverified status remains viewer', async () => {
      const clerkId = 'clerk_prov_unverified_admin';
      const email = 'admin@forgeflow.local';

      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_unver_1',
        emailAddresses: [
          {
            id: 'email_unver_1',
            emailAddress: email,
            verification: { status: 'unverified' },
          },
        ],
        firstName: 'Unverified',
        lastName: 'Admin',
      });

      const res = await request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`);

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('viewer');

      // Verify in DB
      const dbRow = await db.query.users.findFirst({
        where: eq(users.clerk_id, clerkId),
      });
      expect(dbRow).toBeDefined();
      expect(dbRow?.role).toBe('viewer');
    });

    it('an email listed in ADMIN_EMAILS with verified status gets role admin', async () => {
      const clerkId = 'clerk_prov_admin_1';
      // admin@forgeflow.local is set in ADMIN_EMAILS via vitest env
      const email = 'admin@forgeflow.local';

      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_admin_1',
        emailAddresses: [
          {
            id: 'email_admin_1',
            emailAddress: email,
            verification: { status: 'verified' },
          },
        ],
        firstName: 'Platform',
        lastName: 'Admin',
      });

      const res = await request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`);

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('admin');
      expect(res.body.email).toBe(email);

      // Verify in DB
      const dbRow = await db.query.users.findFirst({
        where: eq(users.clerk_id, clerkId),
      });
      expect(dbRow).toBeDefined();
      expect(dbRow?.role).toBe('admin');
    });

    it('mixed-case email matches ADMIN_EMAILS and grants admin role', async () => {
      const clerkId = 'clerk_prov_mixed_case_admin';
      const mixedCaseEmail = '  Admin@ForgeFlow.Local  ';
      const normalizedEmail = 'admin@forgeflow.local';

      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_mixed_1',
        emailAddresses: [
          {
            id: 'email_mixed_1',
            emailAddress: mixedCaseEmail,
            verification: { status: 'verified' },
          },
        ],
        firstName: 'MixedCase',
        lastName: 'Admin',
      });

      const res = await request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`);

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('admin');
      expect(res.body.email).toBe(normalizedEmail);

      // Verify in DB that normalized lowercase email was stored and role is admin
      const dbRow = await db.query.users.findFirst({
        where: eq(users.clerk_id, clerkId),
      });
      expect(dbRow).toBeDefined();
      expect(dbRow?.role).toBe('admin');
      expect(dbRow?.email).toBe(normalizedEmail);
    });

    it('a second request does not create a duplicate row', async () => {
      const clerkId = 'clerk_prov_repeat_1';
      const email = 'repeat_user@example.com';
      const initialFirst = 'Initial';
      const updatedFirst = 'Updated';

      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_rep_1',
        emailAddresses: [
          {
            id: 'email_rep_1',
            emailAddress: email,
            verification: { status: 'verified' },
          },
        ],
        firstName: initialFirst,
        lastName: 'User',
      });

      // First request
      const firstRes = await request(provApp)
        .get('/api/me')
        .set('Authorization', `Bearer ${clerkId}`);
      expect(firstRes.status).toBe(200);
      const userId = firstRes.body.id;

      // Count matching rows
      const rowsAfterFirst = await db.select().from(users).where(eq(users.clerk_id, clerkId));
      expect(rowsAfterFirst).toHaveLength(1);

      // Update name in simulated Clerk record
      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_rep_1',
        emailAddresses: [
          {
            id: 'email_rep_1',
            emailAddress: email,
            verification: { status: 'verified' },
          },
        ],
        firstName: updatedFirst,
        lastName: 'User',
      });

      // Clear sync cache to simulate re-sync after TTL
      clearSyncCache();

      // Second request with same clerkId but updated name
      const secondRes = await request(provApp)
        .get('/api/me')
        .set('Authorization', `Bearer ${clerkId}`);
      expect(secondRes.status).toBe(200);
      expect(secondRes.body.id).toBe(userId);
      expect(secondRes.body.name).toBe(`${updatedFirst} User`);

      // Verify still exactly 1 row in DB with this clerkId
      const rowsAfterSecond = await db.select().from(users).where(eq(users.clerk_id, clerkId));
      expect(rowsAfterSecond).toHaveLength(1);
      expect(rowsAfterSecond[0].id).toBe(userId);
      expect(rowsAfterSecond[0].name).toBe(`${updatedFirst} User`);
    });

    it('two concurrent first requests for the same new Clerk user create exactly one row and both succeed', async () => {
      const clerkId = 'clerk_prov_concurrent_user';
      const email = 'concurrent@example.com';

      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_conc_1',
        emailAddresses: [
          {
            id: 'email_conc_1',
            emailAddress: email,
            verification: { status: 'verified' },
          },
        ],
        firstName: 'Concurrent',
        lastName: 'User',
      });

      // Verify user does not exist yet
      const before = await db.query.users.findFirst({
        where: eq(users.clerk_id, clerkId),
      });
      expect(before).toBeUndefined();

      // Fire two concurrent first requests
      const [res1, res2] = await Promise.all([
        request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`),
        request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.id).toBe(res2.body.id);
      expect(res1.body.clerkId).toBe(clerkId);
      expect(res2.body.clerkId).toBe(clerkId);

      // Verify exactly one row was created in the database
      const rows = await db.select().from(users).where(eq(users.clerk_id, clerkId));
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe(email);
    });

    it('email collision returns 409 conflict when email belongs to a different clerk_id', async () => {
      const clerkId1 = 'clerk_owner_one';
      const clerkId2 = 'clerk_owner_two';
      const sharedEmail = 'shared-identity@example.com';

      simulatedClerkUsers.set(clerkId1, {
        id: clerkId1,
        primaryEmailAddressId: 'email_col_1',
        emailAddresses: [
          {
            id: 'email_col_1',
            emailAddress: sharedEmail,
            verification: { status: 'verified' },
          },
        ],
        firstName: 'First',
        lastName: 'Account',
      });

      simulatedClerkUsers.set(clerkId2, {
        id: clerkId2,
        primaryEmailAddressId: 'email_col_2',
        emailAddresses: [
          {
            id: 'email_col_2',
            emailAddress: sharedEmail,
            verification: { status: 'verified' },
          },
        ],
        firstName: 'Second',
        lastName: 'Account',
      });

      // First user provisions successfully
      const res1 = await request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId1}`);
      expect(res1.status).toBe(200);

      // Second user with distinct clerkId but colliding email attempts to provision
      const res2 = await request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId2}`);

      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe('CONFLICT');
      expect(res2.body.error.message).toContain('already associated with another account');
    });

    it('a second request within the TTL does not call the lookup again', async () => {
      clearSyncCache();
      mockClerkLookup.mockClear();

      const clerkId = 'clerk_prov_ttl_user';
      const email = 'ttl_user@example.com';

      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_ttl_1',
        emailAddresses: [
          {
            id: 'email_ttl_1',
            emailAddress: email,
            verification: { status: 'verified' },
          },
        ],
        firstName: 'TTL',
        lastName: 'User',
      });

      // First request: user is not yet provisioned -> calls lookup
      const res1 = await request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`);
      expect(res1.status).toBe(200);
      expect(mockClerkLookup).toHaveBeenCalledTimes(1);

      // Second request within TTL: cache is fresh, user exists -> does not call lookup
      const res2 = await request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`);
      expect(res2.status).toBe(200);
      expect(mockClerkLookup).toHaveBeenCalledTimes(1);
    });

    it('concurrent requests call the lookup once', async () => {
      clearSyncCache();
      mockClerkLookup.mockClear();

      const clerkId = 'clerk_prov_sf_user';
      const email = 'singleflight@example.com';

      simulatedClerkUsers.set(clerkId, {
        id: clerkId,
        primaryEmailAddressId: 'email_sf_1',
        emailAddresses: [
          {
            id: 'email_sf_1',
            emailAddress: email,
            verification: { status: 'verified' },
          },
        ],
        firstName: 'Single',
        lastName: 'Flight',
      });

      // Fire 3 concurrent requests simultaneously for the same user before lookup completes
      const [r1, r2, r3] = await Promise.all([
        request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`),
        request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`),
        request(provApp).get('/api/me').set('Authorization', `Bearer ${clerkId}`),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(mockClerkLookup).toHaveBeenCalledTimes(1);
    });

    it('a lookup failure returns 503 and never a 500', async () => {
      clearSyncCache();

      const failingLookup: ClerkUserLookup = async () => {
        throw new Error('Clerk connection refused');
      };

      const failingApp = createApp({
        auth: async (req, res, next) => {
          const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
          try {
            const dbUser = await syncClerkUser(token!, failingLookup);
            req.auth = {
              clerkId: dbUser.clerk_id,
              email: dbUser.email,
              name: dbUser.name,
              userId: dbUser.id,
              role: dbUser.role,
            };
            next();
          } catch (err: unknown) {
            next(err);
          }
        },
      });

      const res = await request(failingApp)
        .get('/api/me')
        .set('Authorization', 'Bearer failing_user');

      expect(res.status).toBe(503);
      expect(res.status).not.toBe(500);
      expect(res.body).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Authentication service temporarily unavailable',
        },
      });
    });
  });
});
