import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { auditLogs, services, users } from '../src/db/schema.js';
import { createClerkAuthVerifier } from '../src/middleware/auth.js';
import { resetEnv } from '../src/config/env.js';
import { redactSecrets } from '../src/utils/redact.js';
import { app, cleanTables, seedUsers, testAuthVerifier, testUsers } from './setup.js';

interface RouteEntry {
  method: string;
  path: string;
}

function normalizePath(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function enumerateAppRoutes(expressApp: ReturnType<typeof createApp>): RouteEntry[] {
  const routes: RouteEntry[] = [];

  function walk(stack: unknown[], prefix: string): void {
    for (const rawLayer of stack) {
      const layer = rawLayer as {
        route?: { path: string | string[]; methods: Record<string, boolean> };
        name?: string;
        handle?: { stack?: unknown[] };
        regexp?: RegExp & { fast_slash?: boolean };
      };
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) {
          const full = normalizePath(prefix + p);
          for (const [method, enabled] of Object.entries(layer.route.methods)) {
            if (enabled) {
              routes.push({ method: method.toUpperCase(), path: full });
            }
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        let subPrefix = '';
        if (layer.regexp && !layer.regexp.fast_slash) {
          const src = layer.regexp.source
            .replace(/^\^\\\//, '/')
            .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
            .replace(/\\\//g, '/');
          subPrefix = src.startsWith('/') ? src : `/${src}`;
        }
        walk(layer.handle.stack, normalizePath(prefix + subPrefix));
      }
    }
  }

  const rootStack = (expressApp as unknown as { _router?: { stack?: unknown[] } })._router?.stack;
  if (rootStack) {
    walk(rootStack, '');
  }
  return routes;
}

describe('Checkpoint 4A — Clerk Auth, Members, Ownership & Audit Logs', () => {
  beforeEach(async () => {
    await cleanTables();
    await seedUsers();
  });

  describe('Clerk verifier provisioning, caching, and error handling', () => {
    it('unverified email never becomes admin even if in ADMIN_EMAILS; verified mixed-case email is promoted and never auto-demoted', async () => {
      const origAdmin = process.env.ADMIN_EMAILS;
      process.env.ADMIN_EMAILS = 'admin-candidate@example.com';
      resetEnv();
      try {
        let verifiedFlag = false;
        const verifier = createClerkAuthVerifier({
          verifySessionToken: async (token) => ({ sub: token }),
          fetchClerkUser: async (clerkId) => ({
            clerkId,
            email: '  Admin-Candidate@Example.COM ',
            emailVerified: verifiedFlag,
            name: 'Candidate User',
          }),
          ttlMs: 0,
        });
        const clerkApp = createApp({ auth: verifier });

        // First request: unverified email -> viewer
        const r1 = await request(clerkApp)
          .get('/api/me')
          .set('Authorization', 'Bearer clerk_user_1');
        expect(r1.status).toBe(200);
        expect(r1.body.role).toBe('viewer');
        expect(r1.body.email).toBe('admin-candidate@example.com');

        // Second request: email now verified -> promoted to admin
        verifiedFlag = true;
        const r2 = await request(clerkApp)
          .get('/api/me')
          .set('Authorization', 'Bearer clerk_user_1');
        expect(r2.status).toBe(200);
        expect(r2.body.role).toBe('admin');

        // Third request: removed from ADMIN_EMAILS -> never auto-demoted
        process.env.ADMIN_EMAILS = '';
        resetEnv();
        const r3 = await request(clerkApp)
          .get('/api/me')
          .set('Authorization', 'Bearer clerk_user_1');
        expect(r3.status).toBe(200);
        expect(r3.body.role).toBe('admin');
      } finally {
        if (origAdmin !== undefined) process.env.ADMIN_EMAILS = origAdmin;
        else delete process.env.ADMIN_EMAILS;
        resetEnv();
      }
    });

    it('returns 409 EMAIL_CONFLICT when email already belongs to another Clerk ID', async () => {
      const verifier = createClerkAuthVerifier({
        verifySessionToken: async (token) => ({ sub: token }),
        fetchClerkUser: async (clerkId) => ({
          clerkId,
          email: testUsers.devOwner.email,
          emailVerified: true,
          name: 'Imposter',
        }),
      });
      const clerkApp = createApp({ auth: verifier });

      const res = await request(clerkApp)
        .get('/api/me')
        .set('Authorization', 'Bearer clerk_other_sub');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_CONFLICT');
    });

    it('concurrent first requests coalesce fetchClerkUser (singleflight), cache for TTL, and create one DB row', async () => {
      let fetchCount = 0;
      let currentTime = 1000;
      const verifier = createClerkAuthVerifier({
        verifySessionToken: async (token) => ({ sub: token }),
        fetchClerkUser: async (clerkId) => {
          fetchCount++;
          await new Promise((r) => setTimeout(r, 25));
          return {
            clerkId,
            email: 'concurrent@example.com',
            emailVerified: true,
            name: 'Concurrent User',
          };
        },
        ttlMs: 5 * 60 * 1000,
        now: () => currentTime,
      });
      const clerkApp = createApp({ auth: verifier });

      const [r1, r2, r3] = await Promise.all([
        request(clerkApp).get('/api/me').set('Authorization', 'Bearer clerk_concurrent_1'),
        request(clerkApp).get('/api/me').set('Authorization', 'Bearer clerk_concurrent_1'),
        request(clerkApp).get('/api/me').set('Authorization', 'Bearer clerk_concurrent_1'),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(r1.body.id).toBe(r2.body.id);
      expect(r2.body.id).toBe(r3.body.id);
      expect(fetchCount).toBe(1);

      const rows = await db.select().from(users).where(eq(users.clerk_id, 'clerk_concurrent_1'));
      expect(rows).toHaveLength(1);

      // Within 5m TTL -> still cached
      currentTime += 4 * 60 * 1000;
      await request(clerkApp).get('/api/me').set('Authorization', 'Bearer clerk_concurrent_1');
      expect(fetchCount).toBe(1);

      // Past 5m TTL -> refetches
      currentTime += 2 * 60 * 1000;
      await request(clerkApp).get('/api/me').set('Authorization', 'Bearer clerk_concurrent_1');
      expect(fetchCount).toBe(2);
    });

    it('returns 503 AUTH_UNAVAILABLE on Clerk verify or getUser outage (never 500)', async () => {
      const verifyOutageApp = createApp({
        auth: createClerkAuthVerifier({
          verifySessionToken: async () => {
            throw new Error('Clerk JWKS endpoint unreachable');
          },
        }),
      });
      const r1 = await request(verifyOutageApp)
        .get('/api/me')
        .set('Authorization', 'Bearer any_token');
      expect(r1.status).toBe(503);
      expect(r1.body.error.code).toBe('AUTH_UNAVAILABLE');

      const userOutageApp = createApp({
        auth: createClerkAuthVerifier({
          verifySessionToken: async (token) => ({ sub: token }),
          fetchClerkUser: async () => {
            throw new Error('Clerk API 502 Bad Gateway');
          },
        }),
      });
      const r2 = await request(userOutageApp)
        .get('/api/me')
        .set('Authorization', 'Bearer clerk_sub_outage');
      expect(r2.status).toBe(503);
      expect(r2.body.error.code).toBe('AUTH_UNAVAILABLE');
    });
  });

  describe('Users, Role Management, Ownership Transfer & Audit Logs', () => {
    it('GET /api/users is admin-only with exact camelCase keys; PATCH /api/users/:id/role enforces self-change and last-admin guards and writes audit log', async () => {
      // Viewer and developer get 403
      expect(
        (await request(app).get('/api/users').set('Authorization', 'Bearer viewer-token')).status
      ).toBe(403);
      expect(
        (await request(app).get('/api/users').set('Authorization', 'Bearer dev-owner-token')).status
      ).toBe(403);

      // Admin gets 200
      const listRes = await request(app)
        .get('/api/users')
        .set('Authorization', 'Bearer admin-token');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.length).toBe(4);
      expect(Object.keys(listRes.body.data[0]).sort()).toEqual([
        'clerkId',
        'createdAt',
        'email',
        'id',
        'name',
        'role',
      ]);

      // Self role change blocked (409)
      const selfRes = await request(app)
        .patch(`/api/users/${testUsers.admin.id}/role`)
        .set('Authorization', 'Bearer admin-token')
        .send({ role: 'viewer' });
      expect(selfRes.status).toBe(409);
      expect(selfRes.body.error.code).toBe('SELF_ROLE_CHANGE_NOT_ALLOWED');

      // Promote viewer -> developer (200) and verify audit log
      const promoteRes = await request(app)
        .patch(`/api/users/${testUsers.viewer.id}/role`)
        .set('Authorization', 'Bearer admin-token')
        .send({ role: 'developer' });
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.role).toBe('developer');

      const [auditRow] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'user.role_updated'));
      expect(auditRow).toBeDefined();
      expect(auditRow.actor_id).toBe(testUsers.admin.id);
      expect(auditRow.resource_id).toBe(testUsers.viewer.id);

      // Last admin cannot be demoted by another admin if only 1 admin exists
      // (testUsers.admin is the only admin; simulate second admin trying to demote would fail if count=1,
      // or test directly with DB having 1 admin and another admin header)
      const [secondAdmin] = await db
        .insert(users)
        .values({
          clerk_id: 'temp_admin_check',
          email: 'tempadmin@test.local',
          name: 'Temp Admin',
          role: 'admin',
        })
        .returning();
      // Demote secondAdmin -> succeeds (1 admin remains)
      const demoteSecond = await request(app)
        .patch(`/api/users/${secondAdmin.id}/role`)
        .set('Authorization', 'Bearer admin-token')
        .send({ role: 'viewer' });
      expect(demoteSecond.status).toBe(200);

      // Now promote secondAdmin back, and create a custom verifier where actor is a different ID
      // Actually easiest: test last-admin check by having 1 admin in DB and calling PATCH as a second user whose req.auth.role='admin'
      const fakeAdminApp = createApp({
        auth: (req, _res, next) => {
          req.auth = {
            userId: testUsers.devOwner.id,
            email: testUsers.devOwner.email,
            name: testUsers.devOwner.name,
            role: 'admin',
            clerkId: testUsers.devOwner.clerk_id,
          };
          next();
        },
      });
      const lastAdminRes = await request(fakeAdminApp)
        .patch(`/api/users/${testUsers.admin.id}/role`)
        .send({ role: 'developer' });
      expect(lastAdminRes.status).toBe(409);
      expect(lastAdminRes.body.error.code).toBe('LAST_ADMIN_CANNOT_BE_DEMOTED');
    });

    it('PATCH /api/services/:id/owner transfers ownership (admin only) and writes audit log', async () => {
      const [svc] = await db
        .insert(services)
        .values({
          name: 'owner-xfer-svc',
          slug: 'owner-xfer-svc',
          owner_id: testUsers.devOwner.id,
        })
        .returning();

      // Developer gets 403
      const devRes = await request(app)
        .patch(`/api/services/${svc.id}/owner`)
        .set('Authorization', 'Bearer dev-owner-token')
        .send({ ownerId: testUsers.otherDev.id });
      expect(devRes.status).toBe(403);

      // Admin gets 200
      const adminRes = await request(app)
        .patch(`/api/services/${svc.id}/owner`)
        .set('Authorization', 'Bearer admin-token')
        .send({ ownerId: testUsers.otherDev.id });
      expect(adminRes.status).toBe(200);
      expect(adminRes.body.ownerId).toBe(testUsers.otherDev.id);

      const [auditRow] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'service.owner_updated'));
      expect(auditRow).toBeDefined();
      expect(auditRow.actor_id).toBe(testUsers.admin.id);
      expect(auditRow.resource_id).toBe(svc.id);
    });

    it('GET /api/audit-logs enforces role matrix, supports filters, newest first, and exact camelCase keys', async () => {
      await db.insert(auditLogs).values([
        {
          actor_id: testUsers.devOwner.id,
          action: 'service.create',
          resource_type: 'service',
          resource_id: '11111111-1111-1111-1111-111111111111',
          timestamp: new Date('2026-11-27T10:00:00.000Z'),
        },
        {
          actor_id: testUsers.admin.id,
          action: 'user.role_updated',
          resource_type: 'user',
          resource_id: testUsers.viewer.id,
          timestamp: new Date('2026-11-28T10:00:00.000Z'),
        },
      ]);

      // Viewer gets 403
      expect(
        (await request(app).get('/api/audit-logs').set('Authorization', 'Bearer viewer-token'))
          .status
      ).toBe(403);

      // Developer & Admin get 200
      const devRes = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', 'Bearer dev-owner-token');
      expect(devRes.status).toBe(200);
      expect(devRes.body.data).toHaveLength(2);
      expect(devRes.body.data[0].action).toBe('user.role_updated');
      expect(Object.keys(devRes.body.data[0]).sort()).toEqual([
        'action',
        'actorEmail',
        'actorId',
        'actorName',
        'id',
        'resourceId',
        'resourceType',
        'timestamp',
      ]);

      // Filter by action and resourceType
      const filtered = await request(app)
        .get('/api/audit-logs?action=service.create&resourceType=service')
        .set('Authorization', 'Bearer admin-token');
      expect(filtered.status).toBe(200);
      expect(filtered.body.data).toHaveLength(1);
      expect(filtered.body.data[0].actorEmail).toBe(testUsers.devOwner.email);
    });
  });

  describe('Route Enumeration & Table-Driven Role Matrix', () => {
    it('enumerates all mounted routes, ensures zero missing routes, and enforces auth & RBAC across all of them', async () => {
      const dummyId = '00000000-0000-0000-0000-000000000000';
      const enumerated = enumerateAppRoutes(app);

      interface MatrixSpec {
        method: string;
        path: string;
        public?: boolean;
        webhook?: boolean;
        unauthStatus: number;
        viewerStatus: number[];
        otherDevStatus: number[];
        ownerDevStatus: number[];
        adminStatus: number[];
      }

      const matrix: MatrixSpec[] = [
        {
          method: 'GET',
          path: '/health',
          public: true,
          unauthStatus: 200,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'GET',
          path: '/health/ready',
          public: true,
          unauthStatus: 200,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'POST',
          path: '/api/webhooks/github',
          webhook: true,
          unauthStatus: 503, // webhook secret not configured in default test app (still bypasses Clerk auth)
          viewerStatus: [503],
          otherDevStatus: [503],
          ownerDevStatus: [503],
          adminStatus: [503],
        },
        {
          method: 'GET',
          path: '/api/me',
          unauthStatus: 401,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'GET',
          path: '/api/users',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [403],
          ownerDevStatus: [403],
          adminStatus: [200],
        },
        {
          method: 'PATCH',
          path: '/api/users/:id/role',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [403],
          ownerDevStatus: [403],
          adminStatus: [400, 404],
        },
        {
          method: 'GET',
          path: '/api/audit-logs',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'GET',
          path: '/api/templates',
          unauthStatus: 401,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'GET',
          path: '/api/services',
          unauthStatus: 401,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'POST',
          path: '/api/services/scaffold',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [400],
          ownerDevStatus: [400],
          adminStatus: [400],
        },
        {
          method: 'POST',
          path: '/api/services',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [400],
          ownerDevStatus: [400],
          adminStatus: [400],
        },
        {
          method: 'GET',
          path: '/api/services/:id',
          unauthStatus: 401,
          viewerStatus: [404],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'PATCH',
          path: '/api/services/:id',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'PATCH',
          path: '/api/services/:id/owner',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [403],
          ownerDevStatus: [403],
          adminStatus: [400, 404],
        },
        {
          method: 'DELETE',
          path: '/api/services/:id',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'GET',
          path: '/api/services/:id/ci-runs',
          unauthStatus: 401,
          viewerStatus: [404],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'POST',
          path: '/api/services/:id/ci-runs/sync',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [404, 503],
          ownerDevStatus: [404, 503],
          adminStatus: [404, 503],
        },
        {
          method: 'GET',
          path: '/api/services/:id/deployable-commits',
          unauthStatus: 401,
          viewerStatus: [404],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'GET',
          path: '/api/services/:id/deployments',
          unauthStatus: 401,
          viewerStatus: [404],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'POST',
          path: '/api/services/:id/deployments',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'POST',
          path: '/api/services/:id/environments/development/undeploy',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'GET',
          path: '/api/deployments',
          unauthStatus: 401,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'GET',
          path: '/api/deployments/:id',
          unauthStatus: 401,
          viewerStatus: [404],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'POST',
          path: '/api/deployments/:id/rollback',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'GET',
          path: '/api/workflows',
          unauthStatus: 401,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'GET',
          path: '/api/workflows/:id',
          unauthStatus: 401,
          viewerStatus: [404],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'GET',
          path: '/api/workflows/:id/logs',
          unauthStatus: 401,
          viewerStatus: [404],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'POST',
          path: '/api/workflows/:id/retry',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'POST',
          path: '/api/workflows/:id/cancel',
          unauthStatus: 401,
          viewerStatus: [403],
          otherDevStatus: [404],
          ownerDevStatus: [404],
          adminStatus: [404],
        },
        {
          method: 'GET',
          path: '/api/dashboard/summary',
          unauthStatus: 401,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
        {
          method: 'GET',
          path: '/api/integrations/github',
          unauthStatus: 401,
          viewerStatus: [200],
          otherDevStatus: [200],
          ownerDevStatus: [200],
          adminStatus: [200],
        },
      ];

      const matrixSet = new Set(matrix.map((m) => `${m.method} ${m.path}`));
      const enumSet = new Set(enumerated.map((e) => `${e.method} ${e.path}`));
      const missingFromMatrix = [...enumSet].filter((r) => !matrixSet.has(r));
      expect(missingFromMatrix).toEqual([]);
      console.log('Enumerated routes:', [...enumSet].sort());

      let reqCount = 0;
      let matrixApp = createApp({ auth: testAuthVerifier });

      const execRoute = async (spec: MatrixSpec, token?: string) => {
        if (reqCount > 0 && reqCount % 80 === 0) {
          matrixApp = createApp({ auth: testAuthVerifier });
        }
        reqCount++;
        const targetPath = spec.path.replace(/:id/g, dummyId);
        let req =
          request(matrixApp)[spec.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](
            targetPath
          );
        if (token) {
          req = req.set('Authorization', `Bearer ${token}`);
        }
        if (spec.webhook) {
          return req.set('Content-Type', 'application/json').send({});
        }
        return req.send({});
      };

      for (const spec of matrix) {
        const unauthRes = await execRoute(spec);
        expect(unauthRes.status, `unauth ${spec.method} ${spec.path}`).toBe(spec.unauthStatus);

        const vRes = await execRoute(spec, 'viewer-token');
        expect(spec.viewerStatus, `viewer ${spec.method} ${spec.path}`).toContain(vRes.status);

        const oRes = await execRoute(spec, 'other-dev-token');
        expect(spec.otherDevStatus, `otherDev ${spec.method} ${spec.path}`).toContain(oRes.status);

        const dRes = await execRoute(spec, 'dev-owner-token');
        expect(spec.ownerDevStatus, `ownerDev ${spec.method} ${spec.path}`).toContain(dRes.status);

        const aRes = await execRoute(spec, 'admin-token');
        expect(spec.adminStatus, `admin ${spec.method} ${spec.path}`).toContain(aRes.status);
      }
    });

    it('webhook route works without Clerk auth when configured', async () => {
      const crypto = await import('node:crypto');
      const secret = 'test-webhook-secret-4a';
      const payload = JSON.stringify({ action: 'ping' });
      const sig = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
      const whApp = createApp({
        auth: testAuthVerifier,
        webhooks: { getWebhookSecret: () => secret },
      });
      const res = await request(whApp)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .set('X-GitHub-Delivery', '4a-ping-1')
        .set('X-Hub-Signature-256', sig)
        .send(payload);
      expect(res.status).toBe(200);
    });

    it('redactSecrets strips Clerk secret and publishable keys', () => {
      const sample = 'Error with sk_test_abc1234567890XYZ and pk_live_xyz9876543210ABC';
      const cleaned = redactSecrets(sample);
      expect(cleaned).not.toContain('sk_test_abc1234567890XYZ');
      expect(cleaned).not.toContain('pk_live_xyz9876543210ABC');
      expect(cleaned).toBe('Error with [REDACTED_CLERK_KEY] and [REDACTED_CLERK_KEY]');
    });
  });
});
