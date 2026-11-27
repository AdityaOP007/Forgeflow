import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createApp } from '../src/app.js';
import { testAuthVerifier } from './setup.js';
import { resetEnv, getGitHubConfig } from '../src/config/env.js';
import { RealGitHubClient } from '../src/github/client.js';
import { GitHubError } from '../src/github/types.js';
import { FakeGitHubClient } from './fakes/fake-github-client.js';
import { resetGitHubIntegrationCache } from '../src/modules/integrations/routes.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-gh-test-'));
  tempDirs.push(dir);
  return dir;
}

const VALID_TEST_PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA0Y1abcdefghijklmnopqrstuvwxyz0123456789testkey==',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

const baseConfig = {
  appId: '123456',
  installationId: '789012',
  org: 'forgeflow-test-org',
  privateKeyPath: '/tmp/fake.pem',
  privateKey: VALID_TEST_PEM,
};

afterEach(() => {
  resetGitHubIntegrationCache();
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_INSTALLATION_ID;
  delete process.env.GITHUB_ORG;
  delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  resetEnv();

  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('GitHub App Integration — Checkpoint 2C', () => {
  describe('Environment Configuration & PEM Validation', () => {
    it('returns configured=false without crashing when GitHub env vars are absent', () => {
      resetEnv();
      const res = getGitHubConfig();
      expect(res.configured).toBe(false);
      expect(res.config).toBeNull();
    });

    it('rejects missing or non-PEM private key files and accepts valid PEM files', () => {
      const dir = makeTempDir();
      const badPemPath = path.join(dir, 'bad.pem');
      fs.writeFileSync(badPemPath, 'not a pem file', 'utf8');

      const missingRes = getGitHubConfig({
        GITHUB_APP_ID: '123',
        GITHUB_APP_INSTALLATION_ID: '456',
        GITHUB_ORG: 'my-org',
        GITHUB_APP_PRIVATE_KEY_PATH: path.join(dir, 'missing.pem'),
      });
      expect(missingRes.configured).toBe(false);
      expect(missingRes.error).toContain('does not exist');

      const badPemRes = getGitHubConfig({
        GITHUB_APP_ID: '123',
        GITHUB_APP_INSTALLATION_ID: '456',
        GITHUB_ORG: 'my-org',
        GITHUB_APP_PRIVATE_KEY_PATH: badPemPath,
      });
      expect(badPemRes.configured).toBe(false);
      expect(badPemRes.error).toContain('valid PEM');

      const goodPemPath = path.join(dir, 'good.pem');
      fs.writeFileSync(goodPemPath, VALID_TEST_PEM, 'utf8');
      const goodRes = getGitHubConfig({
        GITHUB_APP_ID: '123',
        GITHUB_APP_INSTALLATION_ID: '456',
        GITHUB_ORG: 'my-org',
        GITHUB_APP_PRIVATE_KEY_PATH: goodPemPath,
      });
      expect(goodRes.configured).toBe(true);
      expect(goodRes.config?.org).toBe('my-org');
    });
  });

  describe('RealGitHubClient — Token Caching, Retries, Error Mapping, Concurrency', () => {
    it('caches installation token until 5 minutes before expiry and refreshes afterwards', async () => {
      let currentNow = 1_700_000_000_000;
      let authCalls = 0;

      const client = new RealGitHubClient(baseConfig, {
        nowMs: () => currentNow,
        authenticateInstallation: async () => {
          authCalls++;
          return {
            token: `ghs_test_token_${authCalls}_abcdefghijklmnopqrstuvwxyz0123`,
            expiresAt: new Date(currentNow + 60 * 60 * 1000).toISOString(), // +60m
          };
        },
      });

      const t1 = await client.getInstallationToken();
      const t2 = await client.getInstallationToken();
      expect(t1).toBe(t2);
      expect(authCalls).toBe(1);

      // Advance 54 minutes (6 minutes before expiry -> still valid)
      currentNow += 54 * 60 * 1000;
      const t3 = await client.getInstallationToken();
      expect(t3).toBe(t1);
      expect(authCalls).toBe(1);

      // Advance 2 more minutes (4 minutes before expiry -> within 5-minute refresh buffer)
      currentNow += 2 * 60 * 1000;
      const t4 = await client.getInstallationToken();
      expect(t4).not.toBe(t1);
      expect(authCalls).toBe(2);
    });

    it('retries 502 upstream errors up to 3 times and succeeds, but does not retry 404', async () => {
      let getCalls502 = 0;
      const client502 = new RealGitHubClient(baseConfig, {
        baseBackoffMs: 1,
        authenticateInstallation: async () => ({
          token: 'ghs_mock_token_123456789012345678901234567890',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        createOctokit: () =>
          ({
            rest: {
              repos: {
                get: async () => {
                  getCalls502++;
                  if (getCalls502 < 3) {
                    const err = new Error('Bad Gateway') as Error & { status: number };
                    err.status = 502;
                    throw err;
                  }
                  return {
                    data: {
                      id: 1,
                      name: 'orders-api',
                      full_name: 'forgeflow-test-org/orders-api',
                      html_url: 'https://github.com/forgeflow-test-org/orders-api',
                      description: null,
                      private: true,
                      default_branch: 'main',
                    },
                  };
                },
              },
            },
          }) as unknown as Octokit,
      });

      const repo = await client502.getRepository('orders-api');
      expect(repo.fullName).toBe('forgeflow-test-org/orders-api');
      expect(getCalls502).toBe(3);

      let getCalls404 = 0;
      const client404 = new RealGitHubClient(baseConfig, {
        baseBackoffMs: 1,
        authenticateInstallation: async () => ({
          token: 'ghs_mock_token_123456789012345678901234567890',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        createOctokit: () =>
          ({
            rest: {
              repos: {
                get: async () => {
                  getCalls404++;
                  const err = new Error('Not Found') as Error & { status: number };
                  err.status = 404;
                  throw err;
                },
              },
            },
          }) as unknown as Octokit,
      });

      await expect(client404.getRepository('missing-repo')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        statusCode: 404,
      });
      expect(getCalls404).toBe(1);
    });

    it('maps 403, 422 already exists, 429, and redacts secrets in error messages', async () => {
      const makeClientWithError = (
        status: number,
        message: string,
        headers?: Record<string, string>
      ) =>
        new RealGitHubClient(baseConfig, {
          baseBackoffMs: 1,
          authenticateInstallation: async () => ({
            token: 'ghs_mock_token_123456789012345678901234567890',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          }),
          createOctokit: () =>
            ({
              rest: {
                repos: {
                  createInOrg: async () => {
                    const err = new Error(message) as Error & {
                      status: number;
                      response?: {
                        status: number;
                        headers?: Record<string, string>;
                        data?: { message: string };
                      };
                    };
                    err.status = status;
                    err.response = { status, headers, data: { message } };
                    throw err;
                  },
                },
              },
            }) as unknown as Octokit,
        });

      // 403 permission denied with Workflows: write + All repositories hint + secret redaction
      await expect(
        makeClientWithError(
          403,
          'Resource not accessible by integration ghs_secret12345678901234567890123456'
        ).createRepository({ name: 'test-svc' })
      ).rejects.toSatisfy((err: GitHubError) => {
        expect(err).toBeInstanceOf(GitHubError);
        expect(err.code).toBe('PERMISSION_DENIED');
        expect(err.message).toContain('Workflows: write');
        expect(err.message).toContain('All repositories');
        expect(err.message).toContain('[REDACTED_TOKEN]');
        expect(err.message).not.toContain('ghs_secret');
        return true;
      });

      // 422 name taken
      await expect(
        makeClientWithError(
          422,
          'Repository creation failed: name already exists on this account'
        ).createRepository({ name: 'dup-svc' })
      ).rejects.toMatchObject({ code: 'NAME_TAKEN', statusCode: 409 });

      // 429 rate limited
      await expect(
        makeClientWithError(429, 'API rate limit exceeded').createRepository({ name: 'rate-svc' })
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });

      // 403 secondary rate limit with retry-after header -> RATE_LIMITED, not PERMISSION_DENIED
      await expect(
        makeClientWithError(403, 'You have exceeded a secondary rate limit', {
          'retry-after': '60',
        }).createRepository({ name: 'secondary-rate-svc' })
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
    });

    it('createCommitWithFiles caps blob concurrency at 5 and never force-updates ref', async () => {
      let activeBlobs = 0;
      let maxActiveBlobs = 0;
      let updateRefForceArg: boolean | undefined;

      const client = new RealGitHubClient(baseConfig, {
        authenticateInstallation: async () => ({
          token: 'ghs_mock_token_123456789012345678901234567890',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        createOctokit: () =>
          ({
            rest: {
              git: {
                getRef: async () => ({ data: { object: { sha: 'head-commit-sha' } } }),
                getCommit: async () => ({
                  data: {
                    sha: 'head-commit-sha',
                    tree: { sha: 'head-tree-sha' },
                    message: 'Initial commit',
                    html_url: 'https://github.com/org/repo/commit/head-commit-sha',
                  },
                }),
                createBlob: async ({ content }: { content: string }) => {
                  activeBlobs++;
                  maxActiveBlobs = Math.max(maxActiveBlobs, activeBlobs);
                  await new Promise((r) => setTimeout(r, 10));
                  activeBlobs--;
                  return { data: { sha: `blob-${content.slice(0, 6)}` } };
                },
                createTree: async () => ({ data: { sha: 'new-tree-sha' } }),
                createCommit: async () => ({
                  data: {
                    sha: 'new-commit-sha',
                    html_url: 'https://github.com/org/repo/commit/new-commit-sha',
                  },
                }),
                updateRef: async ({ force }: { force: boolean }) => {
                  updateRefForceArg = force;
                  return { data: {} };
                },
              },
            },
          }) as unknown as Octokit,
      });

      const files = Array.from({ length: 12 }, (_, idx) => ({
        path: `file-${idx}.txt`,
        content: `content-${idx}`,
      }));

      const result = await client.createCommitWithFiles({
        repo: 'test-repo',
        branch: 'main',
        files,
        message: 'Scaffold commit',
      });

      expect(result.sha).toBe('new-commit-sha');
      expect(maxActiveBlobs).toBeGreaterThan(1);
      expect(maxActiveBlobs).toBeLessThanOrEqual(5);
      expect(updateRefForceArg).toBe(false);
    });
  });

  describe('FakeGitHubClient & Production Import Guard', () => {
    it('supports in-memory store and failure injection', async () => {
      const fake = new FakeGitHubClient({ org: 'my-org' });
      fake.setThrowAfterCreate(new Error('Crash after create'));

      await expect(fake.createRepository({ name: 'crash-svc', private: true })).rejects.toThrow(
        'Crash after create'
      );

      // Repo was created before the injected crash
      const existing = await fake.getRepository('crash-svc');
      expect(existing.fullName).toBe('my-org/crash-svc');

      // Fail after N calls
      fake.setFailAfterNCalls(1);
      await expect(fake.getRepository('crash-svc')).resolves.toBeDefined();
      await expect(fake.getRepository('crash-svc')).rejects.toThrow(GitHubError);
    });

    it('ensures no production file in apps/api/src imports FakeGitHubClient or test/', () => {
      const srcRoot = path.resolve(__dirname, '../src');
      const violations: string[] = [];

      function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith('.ts')) {
            const content = fs.readFileSync(full, 'utf8');
            if (content.includes('fake-github-client') || content.includes('FakeGitHubClient')) {
              violations.push(full);
            }
          }
        }
      }

      walk(srcRoot);
      expect(violations).toEqual([]);
    });
  });

  describe('GET /api/integrations/github', () => {
    beforeEach(() => {
      resetGitHubIntegrationCache();
    });

    it('returns configured=false, connected=false when GitHub env vars are not set', async () => {
      const app = createApp({ auth: testAuthVerifier });
      const res = await request(app)
        .get('/api/integrations/github')
        .set('Authorization', 'Bearer viewer-token');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        configured: false,
        connected: false,
        org: null,
        message: expect.any(String),
      });
    });

    it('returns configured=true, connected=true when configured and org matches, caches for 30s, and never exposes secrets', async () => {
      const dir = makeTempDir();
      const pemPath = path.join(dir, 'app.pem');
      fs.writeFileSync(pemPath, VALID_TEST_PEM, 'utf8');

      process.env.GITHUB_APP_ID = '123456';
      process.env.GITHUB_APP_INSTALLATION_ID = '789012';
      process.env.GITHUB_ORG = 'forgeflow-test-org';
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
      resetEnv();

      const fake = new FakeGitHubClient({ org: 'forgeflow-test-org' });
      const spy = vi.spyOn(fake, 'getInstallationInfo');

      const app = createApp({
        auth: testAuthVerifier,
        integrations: { createClient: () => fake },
      });

      const res1 = await request(app)
        .get('/api/integrations/github')
        .set('Authorization', 'Bearer viewer-token');

      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({
        configured: true,
        connected: true,
        org: 'forgeflow-test-org',
        message: "Connected to GitHub organization 'forgeflow-test-org'",
      });
      expect(JSON.stringify(res1.body)).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(spy).toHaveBeenCalledTimes(1);

      // Second call within 30s hits cache
      const res2 = await request(app)
        .get('/api/integrations/github')
        .set('Authorization', 'Bearer dev-owner-token');

      expect(res2.status).toBe(200);
      expect(res2.body.connected).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('returns connected=false when installation account does not match GITHUB_ORG', async () => {
      const dir = makeTempDir();
      const pemPath = path.join(dir, 'app.pem');
      fs.writeFileSync(pemPath, VALID_TEST_PEM, 'utf8');

      process.env.GITHUB_APP_ID = '123456';
      process.env.GITHUB_APP_INSTALLATION_ID = '789012';
      process.env.GITHUB_ORG = 'expected-org';
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
      resetEnv();

      const fake = new FakeGitHubClient({ org: 'other-org', accountLogin: 'other-org' });
      const app = createApp({
        auth: testAuthVerifier,
        integrations: { createClient: () => fake },
      });

      const res = await request(app)
        .get('/api/integrations/github')
        .set('Authorization', 'Bearer viewer-token');

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(false);
      expect(res.body.org).toBe('expected-org');
    });
  });

  describe('RealGitHubClient — CI Workflow Runs & Jobs (Checkpoint 3C)', () => {
    it('listWorkflowRuns maps GitHub Actions workflow runs and passes filter options', async () => {
      let capturedArgs: Record<string, unknown> | undefined;
      const client = new RealGitHubClient(baseConfig, {
        baseBackoffMs: 1,
        authenticateInstallation: async () => ({
          token: 'ghs_mock_token_123456789012345678901234567890',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        createOctokit: () =>
          ({
            rest: {
              actions: {
                listWorkflowRunsForRepo: async (args: Record<string, unknown>) => {
                  capturedArgs = args;
                  return {
                    data: {
                      workflow_runs: [
                        {
                          id: 9001,
                          run_attempt: 2,
                          head_sha: 'a'.repeat(40),
                          head_branch: 'main',
                          event: 'push',
                          status: 'completed',
                          conclusion: 'success',
                          html_url:
                            'https://github.com/forgeflow-test-org/orders-api/actions/runs/9001',
                          run_started_at: '2026-11-27T08:00:00Z',
                          updated_at: '2026-11-27T08:03:00Z',
                        },
                      ],
                    },
                  };
                },
              },
            },
          }) as unknown as Octokit,
      });

      const runs = await client.listWorkflowRuns('orders-api', {
        branch: 'main',
        headSha: 'a'.repeat(40),
        perPage: 10,
      });

      expect(capturedArgs).toEqual({
        owner: 'forgeflow-test-org',
        repo: 'orders-api',
        branch: 'main',
        head_sha: 'a'.repeat(40),
        per_page: 10,
      });
      expect(runs).toEqual([
        {
          id: 9001,
          runAttempt: 2,
          headSha: 'a'.repeat(40),
          headBranch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/9001',
          runStartedAt: '2026-11-27T08:00:00Z',
          updatedAt: '2026-11-27T08:03:00Z',
        },
      ]);
    });

    it('listWorkflowJobs uses attempt endpoint when runAttempt is provided and default otherwise', async () => {
      let attemptCalledWith: Record<string, unknown> | undefined;
      let defaultCalledWith: Record<string, unknown> | undefined;

      const client = new RealGitHubClient(baseConfig, {
        baseBackoffMs: 1,
        authenticateInstallation: async () => ({
          token: 'ghs_mock_token_123456789012345678901234567890',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        createOctokit: () =>
          ({
            rest: {
              actions: {
                listJobsForWorkflowRunAttempt: async (args: Record<string, unknown>) => {
                  attemptCalledWith = args;
                  return {
                    data: {
                      jobs: [
                        {
                          id: 101,
                          name: 'Publish Image',
                          status: 'completed',
                          conclusion: 'success',
                          started_at: '2026-11-27T08:01:00Z',
                          completed_at: '2026-11-27T08:02:30Z',
                          html_url:
                            'https://github.com/forgeflow-test-org/orders-api/actions/runs/9001/job/101',
                        },
                      ],
                    },
                  };
                },
                listJobsForWorkflowRun: async (args: Record<string, unknown>) => {
                  defaultCalledWith = args;
                  return {
                    data: {
                      jobs: [
                        {
                          id: 102,
                          name: 'Test',
                          status: 'completed',
                          conclusion: 'failure',
                          started_at: '2026-11-27T08:00:10Z',
                          completed_at: '2026-11-27T08:00:55Z',
                          html_url: null,
                        },
                      ],
                    },
                  };
                },
              },
            },
          }) as unknown as Octokit,
      });

      const jobsAttempt = await client.listWorkflowJobs('orders-api', 9001, 2);
      expect(attemptCalledWith).toEqual({
        owner: 'forgeflow-test-org',
        repo: 'orders-api',
        run_id: 9001,
        attempt_number: 2,
        per_page: 100,
      });
      expect(jobsAttempt).toEqual([
        {
          id: 101,
          name: 'Publish Image',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-11-27T08:01:00Z',
          completedAt: '2026-11-27T08:02:30Z',
          htmlUrl: 'https://github.com/forgeflow-test-org/orders-api/actions/runs/9001/job/101',
        },
      ]);

      const jobsDefault = await client.listWorkflowJobs('orders-api', 9001);
      expect(defaultCalledWith).toEqual({
        owner: 'forgeflow-test-org',
        repo: 'orders-api',
        run_id: 9001,
        per_page: 100,
      });
      expect(jobsDefault[0].conclusion).toBe('failure');
    });
  });
});
