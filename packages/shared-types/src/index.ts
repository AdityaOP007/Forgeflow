import { z } from 'zod';

// ─── Health ──────────────────────────────────────────────────────────
export interface HealthResponse {
  status: 'ok';
}

export interface ReadyResponse {
  status: 'ok' | 'degraded';
  database: 'connected' | 'disconnected';
}

// ─── Enums ───────────────────────────────────────────────────────────
export const UserRole = z.enum(['admin', 'developer', 'viewer']);
export type UserRole = z.infer<typeof UserRole>;

export const EnvironmentName = z.enum(['development', 'staging', 'production']);
export type EnvironmentName = z.infer<typeof EnvironmentName>;

export const EnvironmentStatus = z.enum(['unknown', 'healthy', 'degraded', 'failed', 'drifted']);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;

export const WorkflowRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;
export type WorkflowStatus = WorkflowRunStatus;

export const WorkflowStepStatus = z.enum(['waiting', 'running', 'succeeded', 'failed', 'skipped']);
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatus>;

export const ServiceProvisioningStatus = z.enum(['provisioning', 'ready', 'failed']);
export type ServiceProvisioningStatus = z.infer<typeof ServiceProvisioningStatus>;

export const DeploymentStatus = z.enum([
  'queued',
  'in_progress',
  'succeeded',
  'failed',
  'cancelled',
  'rolled_back',
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

// ─── Service validation ─────────────────────────────────────────────
// Lowercase letters, numbers, hyphens; starts with a letter; 3-40 chars.
// Rejects path-traversal patterns (../, /, \).
const slugPattern = /^[a-z][a-z0-9-]{2,39}$/;
const dangerousPattern = /[/\\]|\.\./;

export const serviceNameSchema = z
  .string()
  .regex(
    slugPattern,
    'Name must be lowercase letters, numbers, hyphens; start with a letter; 3 to 40 characters'
  )
  .refine((v) => !dangerousPattern.test(v), 'Name contains invalid characters');

export const serviceSlugSchema = z
  .string()
  .regex(
    slugPattern,
    'Slug must be lowercase letters, numbers, hyphens; start with a letter; 3-40 chars'
  )
  .refine((v) => !dangerousPattern.test(v), 'Slug contains invalid characters');

// Shared repository URL schema: http/https only, optional, max 2048, empty/whitespace transformed to undefined
export const repositoryUrlSchema = z
  .string()
  .max(2048, 'Repository URL must be at most 2048 characters')
  .transform((val) => val.trim())
  .transform((val) => (val === '' ? undefined : val))
  .optional()
  .superRefine((val, ctx) => {
    if (val === undefined) return;
    try {
      const parsed = new URL(val);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Repository URL must start with http:// or https://',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Repository URL must start with http:// or https://',
      });
    }
  });

export const createServiceSchema = z.object({
  name: serviceNameSchema,
  description: z.string().max(500).optional(),
  repositoryUrl: repositoryUrlSchema,
  templateId: z.string().uuid('Must be a valid UUID').optional(),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z.object({
  name: serviceNameSchema.optional(),
  description: z.string().max(500).optional(),
  repositoryUrl: z.union([repositoryUrlSchema, z.null()]).optional(),
});
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

export const scaffoldServiceSchema = z.object({
  name: serviceNameSchema,
  description: z.string().max(300, 'Description must be at most 300 characters').optional(),
  templateId: z.string().uuid('Must be a valid UUID'),
  database: z.literal('postgresql').default('postgresql'),
  repositoryVisibility: z.enum(['private', 'public']).default('private'),
  environment: z.literal('local-docker').default('local-docker'),
});
export type ScaffoldServiceInput = z.infer<typeof scaffoldServiceSchema>;

export interface ScaffoldServiceResponse {
  serviceId: string;
  workflowId: string;
  status: 'queued';
}

// ─── Query params ────────────────────────────────────────────────────
export const listServicesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  owner: z.string().uuid().optional(),
  health: EnvironmentStatus.optional(),
  sort: z.enum(['name', 'createdAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;

// ─── API error shape ─────────────────────────────────────────────────
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ─── Dashboard summary ──────────────────────────────────────────────
export interface DashboardSummary {
  totalServices: number;
  healthyCount: number;
  unhealthyCount: number;
  unknownCount: number;
  activeDeployments: number;
  failedBuilds: number;
  failedWorkflows: number;
  activeWorkflows: number;
}

// ─── User ────────────────────────────────────────────────────────────
export interface UserProfile {
  id: string;
  clerkId: string;
  name: string | null;
  email: string;
  role: UserRole;
  createdAt: string;
}

// ─── Template ────────────────────────────────────────────────────────
export interface TemplateItem {
  id: string;
  name: string;
  slug: string;
  language: string;
  framework: string;
  version: string;
  sourceLocation: string;
  available: boolean;
  createdAt: string;
}

// ─── Service ─────────────────────────────────────────────────────────
export interface ServiceListItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  ownerId: string;
  ownerName: string | null;
  repositoryUrl: string | null;
  templateId: string | null;
  templateName: string | null;
  provisioningStatus: ServiceProvisioningStatus;
  templateVersion: string | null;
  latestWorkflowId: string | null;
  health: EnvironmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentItem {
  id: string;
  serviceId: string;
  name: EnvironmentName;
  cluster: string | null;
  namespace: string | null;
  deployedVersion: string | null;
  status: EnvironmentStatus;
  nodePort?: number | null;
  url?: string | null;
  deployedImage?: string | null;
  deployedCommitSha?: string | null;
  observedImage?: string | null;
  observedReplicas?: number | null;
  observedReadyReplicas?: number | null;
  lastObservedAt?: string | null;
  lastObservedError?: string | null;
}

// ─── CI Runs & Deployments ───────────────────────────────────────────
export interface CiJobItem {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
}

export interface CiRunItem {
  id: string;
  serviceId: string;
  githubRunId: number;
  runAttempt: number;
  headSha: string;
  headBranch: string | null;
  event: string | null;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
  jobs: CiJobItem[];
  publishSucceeded: boolean;
  runStartedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListCiRunsResponse {
  data: CiRunItem[];
}

export interface SyncCiRunsResponse {
  data: CiRunItem[];
  synced: number;
}

export interface DeployableCommitItem {
  commitSha: string;
  shortSha: string;
  ciRunId: string;
  htmlUrl: string | null;
  completedAt: string;
}

export interface ListDeployableCommitsResponse {
  data: DeployableCommitItem[];
}

export interface DeploymentItem {
  id: string;
  serviceId: string;
  environmentId: string;
  workflowRunId: string | null;
  commitSha: string;
  image: string;
  status: DeploymentStatus;
  rollbackOf: string | null;
  triggeredBy: string | null;
  helmRevision: number | null;
  errorSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export const deployServiceSchema = z.object({
  environment: z.literal('development').default('development'),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'commitSha must be a 40-character lowercase hex SHA')
    .optional(),
});
export type DeployServiceInput = z.infer<typeof deployServiceSchema>;

export const rollbackDeploymentSchema = z.object({
  environment: z.literal('development').default('development'),
});
export type RollbackDeploymentInput = z.infer<typeof rollbackDeploymentSchema>;

export const listDeploymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: DeploymentStatus.optional(),
  serviceId: z.string().uuid().optional(),
  environment: EnvironmentName.optional(),
});
export type ListDeploymentsQuery = z.infer<typeof listDeploymentsQuerySchema>;

export interface DeployServiceResponse {
  deploymentId: string;
  workflowId: string | null;
  status: 'queued' | 'succeeded';
  noop?: boolean;
}

export interface UndeployServiceResponse {
  workflowId: string;
  status: 'queued';
}

export interface ListDeploymentsResponse {
  data: DeploymentItem[];
}

export interface WorkflowRunItem {
  id: string;
  serviceId: string;
  type: string;
  status: WorkflowRunStatus;
  externalRunId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorSummary: string | null;
}

export interface WorkflowStep {
  id: string;
  workflowRunId: string;
  key: string;
  name: string;
  position: number;
  status: WorkflowStepStatus;
  startedAt: string | null;
  completedAt: string | null;
  errorSummary: string | null;
}

export interface WorkflowLog {
  id: number;
  workflowRunId: string;
  stepKey: string | null;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface WorkflowRun {
  id: string;
  serviceId: string;
  type: string;
  status: WorkflowStatus;
  input: Record<string, unknown>;
  resources: Record<string, unknown>;
  attempts: number;
  lockedAt: string | null;
  lockedBy: string | null;
  cancelRequested: boolean;
  createdBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorSummary: string | null;
  createdAt: string;
}

export interface ServiceDetail extends ServiceListItem {
  environments: EnvironmentItem[];
  workflowRuns: WorkflowRunItem[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ─── Workflows API ───────────────────────────────────────────────────
export const WorkflowType = z.enum(['scaffold', 'deploy', 'undeploy']);
export type WorkflowType = z.infer<typeof WorkflowType>;

export const listWorkflowsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: WorkflowRunStatus.optional(),
  type: WorkflowType.optional(),
  serviceId: z.string().uuid().optional(),
});
export type ListWorkflowsQuery = z.infer<typeof listWorkflowsQuerySchema>;

export const workflowLogsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});
export type WorkflowLogsQuery = z.infer<typeof workflowLogsQuerySchema>;

export interface WorkflowListItem {
  id: string;
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  type: string;
  status: WorkflowRunStatus;
  attempts: number;
  cancelRequested: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  errorSummary: string | null;
}

export interface WorkflowDetailResponse extends WorkflowRun {
  serviceName: string;
  serviceSlug: string;
  failedStepKey: string | null;
  steps: WorkflowStep[];
}

export interface WorkflowLogsResponse {
  logs: WorkflowLog[];
  nextCursor: number | null;
}

// ─── GitHub Integration ──────────────────────────────────────────────
export interface GitHubIntegrationStatus {
  configured: boolean;
  connected: boolean;
  org: string | null;
  message: string;
}

// ─── Slug generation helper ──────────────────────────────────────────
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ─── Safe HTTPS URL check ────────────────────────────────────────────
export const PUBLISH_JOB_NAME = 'Publish Image' as const;

export function isSafeHttpsUrl(url: string | null | undefined): url is string {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('https://')) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const ALLOWED_APP_PORT_MIN = 30080;
export const ALLOWED_APP_PORT_MAX = 30089;

export function isSafeApplicationUrl(url: string | null | undefined): url is string {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://127.0.0.1:')) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return false;
    if (parsed.hostname !== '127.0.0.1') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (!/^\d+$/.test(parsed.port)) return false;
    const port = Number(parsed.port);
    return port >= ALLOWED_APP_PORT_MIN && port <= ALLOWED_APP_PORT_MAX;
  } catch {
    return false;
  }
}
