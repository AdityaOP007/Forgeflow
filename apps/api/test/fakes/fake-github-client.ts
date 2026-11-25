import crypto from 'crypto';
import {
  GitHubError,
  type CreateCommitWithFilesInput,
  type CreateRepositoryInput,
  type GitHubClient,
  type GitHubCommitResult,
  type GitHubHeadCommit,
  type GitHubInstallationInfo,
  type GitHubRepository,
} from '../../src/github/types.js';

export interface StoredRepo {
  repo: GitHubRepository;
  branches: Map<
    string,
    {
      headSha: string;
      treeSha: string;
      commits: Array<{
        sha: string;
        treeSha: string;
        message: string;
        files: Map<string, string>;
      }>;
    }
  >;
}

export interface FakeGitHubClientOptions {
  org?: string;
  installationId?: string;
  accountLogin?: string;
  repositorySelection?: string;
  permissions?: Record<string, string>;
}

export class FakeGitHubClient implements GitHubClient {
  readonly org: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly repositorySelection: string;
  readonly permissions: Record<string, string>;

  readonly repos = new Map<string, StoredRepo>();
  callCount = 0;

  // Failure injection controls
  private failAfterCalls: number | null = null;
  private failWithError: Error | null = null;
  private throwAfterCreateError: Error | null = null;
  private failNextCreateCommitError: Error | null = null;

  constructor(options: FakeGitHubClientOptions = {}) {
    this.org = options.org ?? 'forgeflow-test-org';
    this.installationId = options.installationId ?? '999999';
    this.accountLogin = options.accountLogin ?? this.org;
    this.repositorySelection = options.repositorySelection ?? 'all';
    this.permissions = options.permissions ?? {
      administration: 'write',
      contents: 'write',
      workflows: 'write',
      actions: 'read',
      metadata: 'read',
    };
  }

  /** Inject an error after N subsequent client calls. */
  setFailAfterNCalls(
    n: number,
    err: Error = new GitHubError('UPSTREAM_ERROR', 'Injected failure', 502)
  ): void {
    this.failAfterCalls = this.callCount + n;
    this.failWithError = err;
  }

  /** Inject an error thrown immediately AFTER createRepository stores the repo (simulates crash after create). */
  setThrowAfterCreate(err: Error = new Error('Simulated crash after repository creation')): void {
    this.throwAfterCreateError = err;
  }

  /** Inject a one-shot error on the next createCommitWithFiles call. */
  setFailNextCommit(err: Error): void {
    this.failNextCreateCommitError = err;
  }

  clearFailureInjection(): void {
    this.failAfterCalls = null;
    this.failWithError = null;
    this.throwAfterCreateError = null;
    this.failNextCreateCommitError = null;
  }

  private recordCall(): void {
    this.callCount++;
    if (this.failAfterCalls !== null && this.callCount > this.failAfterCalls) {
      throw this.failWithError ?? new GitHubError('UPSTREAM_ERROR', 'Injected call failure', 502);
    }
  }

  private nextSha(): string {
    return crypto.randomBytes(20).toString('hex');
  }

  async getInstallationInfo(): Promise<GitHubInstallationInfo> {
    this.recordCall();
    return {
      installationId: this.installationId,
      accountLogin: this.accountLogin,
      accountType: 'Organization',
      repositorySelection: this.repositorySelection,
      permissions: { ...this.permissions },
    };
  }

  async getRepository(name: string): Promise<GitHubRepository> {
    this.recordCall();
    const stored = this.repos.get(name);
    if (!stored) {
      throw new GitHubError('NOT_FOUND', `Repository ${this.org}/${name} not found`, 404);
    }
    return { ...stored.repo };
  }

  async createRepository(input: CreateRepositoryInput): Promise<GitHubRepository> {
    this.recordCall();
    if (this.repos.has(input.name)) {
      throw new GitHubError(
        'NAME_TAKEN',
        `Repository ${this.org}/${input.name} already exists`,
        409
      );
    }

    const defaultBranch = 'main';
    const initCommitSha = this.nextSha();
    const initTreeSha = this.nextSha();
    const repo: GitHubRepository = {
      id: this.repos.size + 1,
      name: input.name,
      fullName: `${this.org}/${input.name}`,
      url: `https://github.com/${this.org}/${input.name}`,
      description: input.description ?? null,
      private: input.private ?? true,
      defaultBranch,
    };

    const branches = new Map();
    branches.set(defaultBranch, {
      headSha: initCommitSha,
      treeSha: initTreeSha,
      commits: [
        {
          sha: initCommitSha,
          treeSha: initTreeSha,
          message: 'Initial commit',
          files: new Map<string, string>(),
        },
      ],
    });

    this.repos.set(input.name, { repo, branches });

    if (this.throwAfterCreateError) {
      const err = this.throwAfterCreateError;
      this.throwAfterCreateError = null;
      throw err;
    }

    return { ...repo };
  }

  async deleteRepository(name: string): Promise<void> {
    this.recordCall();
    if (!this.repos.has(name)) {
      throw new GitHubError('NOT_FOUND', `Repository ${this.org}/${name} not found`, 404);
    }
    this.repos.delete(name);
  }

  async getHeadCommit(repo: string, branch: string): Promise<GitHubHeadCommit> {
    this.recordCall();
    const stored = this.repos.get(repo);
    if (!stored) {
      throw new GitHubError('NOT_FOUND', `Repository ${this.org}/${repo} not found`, 404);
    }
    const branchState = stored.branches.get(branch);
    if (!branchState) {
      throw new GitHubError('NOT_FOUND', `Branch ${branch} not found`, 404);
    }
    const head = branchState.commits[branchState.commits.length - 1];
    return {
      sha: head.sha,
      treeSha: head.treeSha,
      message: head.message,
      url: `https://github.com/${this.org}/${repo}/commit/${head.sha}`,
    };
  }

  async createCommitWithFiles(input: CreateCommitWithFilesInput): Promise<GitHubCommitResult> {
    this.recordCall();
    if (this.failNextCreateCommitError) {
      const err = this.failNextCreateCommitError;
      this.failNextCreateCommitError = null;
      throw err;
    }

    const stored = this.repos.get(input.repo);
    if (!stored) {
      throw new GitHubError('NOT_FOUND', `Repository ${this.org}/${input.repo} not found`, 404);
    }
    const branchState = stored.branches.get(input.branch);
    if (!branchState) {
      throw new GitHubError('NOT_FOUND', `Branch ${input.branch} not found`, 404);
    }

    const prev = branchState.commits[branchState.commits.length - 1];
    const nextFiles = new Map(prev.files);
    for (const f of input.files) {
      nextFiles.set(f.path, f.content);
    }

    const newSha = this.nextSha();
    const newTreeSha = this.nextSha();
    branchState.headSha = newSha;
    branchState.treeSha = newTreeSha;
    branchState.commits.push({
      sha: newSha,
      treeSha: newTreeSha,
      message: input.message,
      files: nextFiles,
    });

    return {
      sha: newSha,
      url: `https://github.com/${this.org}/${input.repo}/commit/${newSha}`,
    };
  }
}
