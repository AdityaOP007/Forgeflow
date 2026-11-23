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

// ─── Slug generation helper ──────────────────────────────────────────
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
