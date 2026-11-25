export type GitHubErrorCode =
  'NOT_FOUND' | 'PERMISSION_DENIED' | 'NAME_TAKEN' | 'RATE_LIMITED' | 'UPSTREAM_ERROR';

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly statusCode: number;

  constructor(code: GitHubErrorCode, message: string, statusCode = 502) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface GitHubInstallationInfo {
  installationId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

export interface CreateRepositoryInput {
  name: string;
  description?: string;
  private?: boolean;
}

export interface GitHubHeadCommit {
  sha: string;
  treeSha: string;
  message: string;
  url: string;
}

export interface GitHubCommitFile {
  path: string;
  content: string;
}

export interface CreateCommitWithFilesInput {
  repo: string;
  branch: string;
  files: GitHubCommitFile[];
  message: string;
}

export interface GitHubCommitResult {
  sha: string;
  url: string;
}

export interface GitHubClient {
  getInstallationInfo(): Promise<GitHubInstallationInfo>;
  getRepository(name: string): Promise<GitHubRepository>;
  createRepository(input: CreateRepositoryInput): Promise<GitHubRepository>;
  deleteRepository(name: string): Promise<void>;
  getHeadCommit(repo: string, branch: string): Promise<GitHubHeadCommit>;
  createCommitWithFiles(input: CreateCommitWithFilesInput): Promise<GitHubCommitResult>;
}
