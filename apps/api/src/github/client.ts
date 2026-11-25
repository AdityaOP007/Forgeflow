import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { redactSecrets } from '../utils/redact.js';
import type { GitHubConfig } from '../config/env.js';
import {
  GitHubError,
  type CreateCommitWithFilesInput,
  type CreateRepositoryInput,
  type GitHubClient,
  type GitHubCommitResult,
  type GitHubHeadCommit,
  type GitHubInstallationInfo,
  type GitHubRepository,
} from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const MAX_RETRIES = 3;
const BLOB_CONCURRENCY_LIMIT = 5;
export const GITHUB_API_VERSION = '2026-03-10';

export interface RealGitHubClientOptions {
  /** Custom Octokit factory for testing with mocked HTTP transport. */
  createOctokit?: (token: string) => Octokit;
  /** Custom auth function for testing token caching and expiry. */
  authenticateInstallation?: () => Promise<{ token: string; expiresAt: string }>;
  /** Base backoff in ms for retries (default 200ms). */
  baseBackoffMs?: number;
  /** Clock provider for testing token expiry. */
  nowMs?: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

interface HttpLikeError {
  status?: number;
  message?: string;
  code?: string;
  response?: {
    status?: number;
    headers?: Record<string, string | undefined>;
    data?: {
      message?: string;
      errors?: Array<{ message?: string; code?: string }>;
    };
  };
}

function isRetryableError(err: unknown): boolean {
  const e = err as HttpLikeError | undefined;
  if (!e) return false;
  const status = e.status ?? e.response?.status;
  if (typeof status === 'number') {
    return status >= 500;
  }
  // Network / transport errors without an HTTP status
  return true;
}

function mapToGitHubError(err: unknown, context: string): GitHubError {
  if (err instanceof GitHubError) {
    return err;
  }

  const e = (err ?? {}) as HttpLikeError;
  const status = e.status ?? e.response?.status;
  const rawMessage = e.response?.data?.message || e.message || 'Unknown GitHub API error';
  const safeMessage = redactSecrets(rawMessage);
  const errorsDetail = e.response?.data?.errors
    ?.map((item) => item.message || item.code || '')
    .filter(Boolean)
    .join('; ');

  if (status === 404) {
    return new GitHubError('NOT_FOUND', `${context}: ${safeMessage}`, 404);
  }

  if (status === 429) {
    return new GitHubError(
      'RATE_LIMITED',
      `${context}: GitHub API rate limit exceeded (${safeMessage})`,
      429
    );
  }

  if (status === 403) {
    const headers = e.response?.headers ?? {};
    const remaining = headers['x-ratelimit-remaining'];
    const retryAfter = headers['retry-after'];
    if (
      remaining === '0' ||
      retryAfter !== undefined ||
      /rate limit|secondary rate limit/i.test(safeMessage)
    ) {
      return new GitHubError(
        'RATE_LIMITED',
        `${context}: GitHub API rate limit exceeded (${safeMessage})`,
        429
      );
    }
    return new GitHubError(
      'PERMISSION_DENIED',
      `${context}: Permission denied (${safeMessage}). Check GitHub App permissions (Administration: write, Contents: write, Workflows: write, Metadata: read) and ensure the App is installed on "All repositories".`,
      403
    );
  }

  if (status === 401) {
    return new GitHubError(
      'PERMISSION_DENIED',
      `${context}: GitHub authentication failed (${safeMessage}). Check GitHub App credentials and installation permissions (including Workflows: write and "All repositories").`,
      401
    );
  }

  if (status === 422) {
    const combined = `${safeMessage} ${errorsDetail ?? ''}`;
    if (/already exists/i.test(combined)) {
      return new GitHubError(
        'NAME_TAKEN',
        `${context}: Repository name already exists (${redactSecrets(combined.trim())})`,
        409
      );
    }
    return new GitHubError(
      'UPSTREAM_ERROR',
      `${context}: GitHub validation error (${redactSecrets(combined.trim())})`,
      422
    );
  }

  return new GitHubError(
    'UPSTREAM_ERROR',
    `${context}: GitHub upstream error (${safeMessage})`,
    typeof status === 'number' && status >= 500 ? 502 : 502
  );
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export class RealGitHubClient implements GitHubClient {
  private readonly config: GitHubConfig;
  private readonly createOctokit: (token: string) => Octokit;
  private readonly authenticateInstallation: () => Promise<{ token: string; expiresAt: string }>;
  private readonly baseBackoffMs: number;
  private readonly nowMs: () => number;

  private cachedToken: CachedToken | null = null;
  private inFlightAuth: Promise<string> | null = null;

  constructor(config: GitHubConfig, options: RealGitHubClientOptions = {}) {
    this.config = config;
    this.baseBackoffMs = options.baseBackoffMs ?? 200;
    this.nowMs = options.nowMs ?? (() => Date.now());
    const defaultRequest = new Octokit().request.defaults({
      headers: { 'x-github-api-version': GITHUB_API_VERSION },
    });

    const createVersionedOctokit = (token: string) => {
      const octokit = new Octokit({ auth: token });
      octokit.request = octokit.request.defaults({
        headers: { 'x-github-api-version': GITHUB_API_VERSION },
      });
      return octokit;
    };

    this.createOctokit = options.createOctokit ?? createVersionedOctokit;

    if (options.authenticateInstallation) {
      this.authenticateInstallation = options.authenticateInstallation;
    } else {
      const appAuth = createAppAuth({
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: Number(config.installationId),
        request: defaultRequest,
      });
      this.authenticateInstallation = async () => {
        const authResult = await appAuth({ type: 'installation' });
        return {
          token: authResult.token,
          expiresAt: authResult.expiresAt || new Date(this.nowMs() + 60 * 60 * 1000).toISOString(),
        };
      };
    }
  }

  async getInstallationToken(): Promise<string> {
    const now = this.nowMs();
    if (this.cachedToken && this.cachedToken.expiresAtMs - TOKEN_REFRESH_BUFFER_MS > now) {
      return this.cachedToken.token;
    }

    if (this.inFlightAuth) {
      return this.inFlightAuth;
    }

    this.inFlightAuth = (async () => {
      try {
        const res = await this.withRetry('Authenticate GitHub App installation', () =>
          this.authenticateInstallation()
        );
        const expiresAtMs = Date.parse(res.expiresAt);
        this.cachedToken = {
          token: res.token,
          expiresAtMs: Number.isNaN(expiresAtMs) ? this.nowMs() + 55 * 60 * 1000 : expiresAtMs,
        };
        return res.token;
      } finally {
        this.inFlightAuth = null;
      }
    })();

    return this.inFlightAuth;
  }

  private async getOctokit(): Promise<Octokit> {
    const token = await this.getInstallationToken();
    return this.createOctokit(token);
  }

  private async withRetry<T>(context: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err) || attempt === MAX_RETRIES) {
          throw mapToGitHubError(err, context);
        }
        const delayMs = this.baseBackoffMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw mapToGitHubError(lastError, context);
  }

  async getInstallationInfo(): Promise<GitHubInstallationInfo> {
    // Obtain installation token first (proves token exchange works)
    await this.getInstallationToken();

    // Query installation repositories/metadata or installation endpoint
    // Note: App JWT is required for GET /app/installations/{id}, whereas installation token
    // can inspect installation repositories or we can authenticate as app JWT when using real app.
    // Using GET /installation/repositories gives repository_selection & permissions check via token,
    // or if appAuth is available we can read /app/installations/{installation_id}.
    return this.withRetry('Get GitHub App installation info', async () => {
      const authRequest = new Octokit().request.defaults({
        headers: { 'x-github-api-version': GITHUB_API_VERSION },
      });
      const appAuth = createAppAuth({
        appId: this.config.appId,
        privateKey: this.config.privateKey,
        request: authRequest,
      });
      const jwtAuth = await appAuth({ type: 'app' });
      const appOctokit = this.createOctokit(jwtAuth.token);
      const { data } = await appOctokit.request('GET /app/installations/{installation_id}', {
        installation_id: Number(this.config.installationId),
      });

      const account = data.account as { login?: string; type?: string } | null;
      return {
        installationId: String(data.id),
        accountLogin: account?.login ?? '',
        accountType: account?.type ?? 'Organization',
        repositorySelection: data.repository_selection ?? 'selected',
        permissions: (data.permissions ?? {}) as Record<string, string>,
      };
    });
  }

  async getRepository(name: string): Promise<GitHubRepository> {
    const octokit = await this.getOctokit();
    return this.withRetry(`Get repository ${this.config.org}/${name}`, async () => {
      const { data } = await octokit.rest.repos.get({
        owner: this.config.org,
        repo: name,
      });
      return {
        id: data.id,
        name: data.name,
        fullName: data.full_name,
        url: data.html_url,
        description: data.description ?? null,
        private: data.private,
        defaultBranch: data.default_branch,
      };
    });
  }

  async createRepository(input: CreateRepositoryInput): Promise<GitHubRepository> {
    const octokit = await this.getOctokit();
    return this.withRetry(`Create repository ${this.config.org}/${input.name}`, async () => {
      const { data } = await octokit.rest.repos.createInOrg({
        org: this.config.org,
        name: input.name,
        description: input.description,
        private: input.private ?? true,
        auto_init: true,
      });
      return {
        id: data.id,
        name: data.name,
        fullName: data.full_name,
        url: data.html_url,
        description: data.description ?? null,
        private: data.private,
        defaultBranch: data.default_branch,
      };
    });
  }

  async deleteRepository(name: string): Promise<void> {
    const octokit = await this.getOctokit();
    await this.withRetry(`Delete repository ${this.config.org}/${name}`, async () => {
      await octokit.rest.repos.delete({
        owner: this.config.org,
        repo: name,
      });
    });
  }

  async getHeadCommit(repo: string, branch: string): Promise<GitHubHeadCommit> {
    const octokit = await this.getOctokit();
    return this.withRetry(`Get head commit for ${this.config.org}/${repo}@${branch}`, async () => {
      const { data: refData } = await octokit.rest.git.getRef({
        owner: this.config.org,
        repo,
        ref: `heads/${branch}`,
      });
      const commitSha = refData.object.sha;
      const { data: commitData } = await octokit.rest.git.getCommit({
        owner: this.config.org,
        repo,
        commit_sha: commitSha,
      });
      return {
        sha: commitData.sha,
        treeSha: commitData.tree.sha,
        message: commitData.message,
        url: commitData.html_url,
      };
    });
  }

  async createCommitWithFiles(input: CreateCommitWithFilesInput): Promise<GitHubCommitResult> {
    const octokit = await this.getOctokit();
    const owner = this.config.org;
    const { repo, branch, files, message } = input;

    // 1. Read head commit and its base tree
    const head = await this.getHeadCommit(repo, branch);

    // 2. Create blobs with concurrency capped at 5
    const blobs = await runWithConcurrency(files, BLOB_CONCURRENCY_LIMIT, async (file) => {
      return this.withRetry(`Create blob for ${file.path}`, async () => {
        const { data } = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: Buffer.from(file.content, 'utf8').toString('base64'),
          encoding: 'base64',
        });
        return {
          path: file.path,
          sha: data.sha,
        };
      });
    });

    // 3. Create tree with base_tree = head.treeSha
    const treeSha = await this.withRetry(`Create tree for ${owner}/${repo}`, async () => {
      const { data } = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: head.treeSha,
        tree: blobs.map((b) => ({
          path: b.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: b.sha,
        })),
      });
      return data.sha;
    });

    // 4. Create commit with parent = head.sha
    const commit = await this.withRetry(`Create commit for ${owner}/${repo}`, async () => {
      const { data } = await octokit.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: treeSha,
        parents: [head.sha],
      });
      return {
        sha: data.sha,
        url: data.html_url,
      };
    });

    // 5. Update branch ref (never force)
    await this.withRetry(`Update ref heads/${branch} for ${owner}/${repo}`, async () => {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.sha,
        force: false,
      });
    });

    return commit;
  }
}
