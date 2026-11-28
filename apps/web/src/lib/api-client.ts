import type {
  HealthResponse,
  UserProfile,
  DashboardSummary,
  ServiceListItem,
  ServiceDetail,
  TemplateItem,
  PaginatedResponse,
  CreateServiceInput,
  UpdateServiceInput,
  ListServicesQuery,
  ScaffoldServiceInput,
  ScaffoldServiceResponse,
  ListWorkflowsQuery,
  WorkflowListItem,
  WorkflowDetailResponse,
  WorkflowLogsResponse,
  GitHubIntegrationStatus,
  CiRunItem,
  ListCiRunsResponse,
  SyncCiRunsResponse,
  DeployableCommitItem,
  ListDeployableCommitsResponse,
  DeploymentItem,
  ListDeploymentsQuery,
  ListDeploymentsResponse,
  DeployServiceInput,
  DeployServiceResponse,
  RollbackDeploymentInput,
  UndeployServiceResponse,
  ListUsersResponse,
  UserRole,
  AuditLogItem,
  ListAuditLogsQuery,
} from '@forgeflow/shared-types';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

let authTokenGetter: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(getter: () => Promise<string | null>): void {
  authTokenGetter = getter;
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { retries?: number } = {}
): Promise<T> {
  const { headers, retries = 3, ...rest } = options;
  const url = `${API_BASE_URL}${path}`;

  let attempt = 0;
  while (true) {
    try {
      const token = authTokenGetter ? await authTokenGetter() : null;
      const res = await fetch(url, {
        ...rest,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      });

      if (!res.ok) {
        let errBody: { error?: { message?: string; code?: string } } | null = null;
        try {
          errBody = await res.json();
        } catch {
          // not json
        }
        const message = errBody?.error?.message || `Request failed with status ${res.status}`;

        // Retry 502/503/504 gateway/service errors during server startup
        if (res.status >= 502 && res.status <= 504 && attempt < retries) {
          attempt++;
          await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 3000)));
          continue;
        }

        throw new ApiError(res.status, message, errBody);
      }

      if (res.status === 204) {
        return null as T;
      }

      return res.json();
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Network error (e.g. server starting up, connection refused)
      if (attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 3000)));
        continue;
      }
      throw err;
    }
  }
}

// ─── Typed API endpoints ─────────────────────────────────────────────

export async function fetchHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/health');
}

export async function fetchMe(): Promise<UserProfile> {
  return apiRequest<UserProfile>('/api/me');
}

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  return apiRequest<DashboardSummary>('/api/dashboard/summary');
}

export async function fetchServices(
  query?: Partial<ListServicesQuery>
): Promise<PaginatedResponse<ServiceListItem>> {
  const params = new URLSearchParams();
  if (query?.page) params.set('page', String(query.page));
  if (query?.pageSize) params.set('pageSize', String(query.pageSize));
  if (query?.search) params.set('search', query.search);
  if (query?.health) params.set('health', query.health);
  if (query?.owner) params.set('owner', query.owner);
  if (query?.sort) params.set('sort', query.sort);
  if (query?.order) params.set('order', query.order);

  const qs = params.toString();
  return apiRequest<PaginatedResponse<ServiceListItem>>(`/api/services${qs ? `?${qs}` : ''}`);
}

export async function fetchServiceById(id: string): Promise<ServiceDetail> {
  return apiRequest<ServiceDetail>(`/api/services/${id}`);
}

export async function createService(input: CreateServiceInput): Promise<ServiceDetail> {
  return apiRequest<ServiceDetail>('/api/services', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateService(id: string, input: UpdateServiceInput): Promise<ServiceDetail> {
  return apiRequest<ServiceDetail>(`/api/services/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteService(id: string): Promise<void> {
  return apiRequest<void>(`/api/services/${id}`, {
    method: 'DELETE',
  });
}

export async function fetchTemplates(): Promise<TemplateItem[]> {
  return apiRequest<TemplateItem[]>('/api/templates');
}

export async function fetchGitHubIntegration(): Promise<GitHubIntegrationStatus> {
  return apiRequest<GitHubIntegrationStatus>('/api/integrations/github');
}

export async function scaffoldService(
  input: ScaffoldServiceInput
): Promise<ScaffoldServiceResponse> {
  return apiRequest<ScaffoldServiceResponse>('/api/services/scaffold', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchWorkflows(
  query?: Partial<ListWorkflowsQuery>
): Promise<PaginatedResponse<WorkflowListItem>> {
  const params = new URLSearchParams();
  if (query?.page) params.set('page', String(query.page));
  if (query?.pageSize) params.set('pageSize', String(query.pageSize));
  if (query?.status) params.set('status', query.status);
  if (query?.type) params.set('type', query.type);
  if (query?.serviceId) params.set('serviceId', query.serviceId);

  const qs = params.toString();
  return apiRequest<PaginatedResponse<WorkflowListItem>>(`/api/workflows${qs ? `?${qs}` : ''}`);
}

export async function fetchWorkflowById(id: string): Promise<WorkflowDetailResponse> {
  return apiRequest<WorkflowDetailResponse>(`/api/workflows/${id}`);
}

export async function fetchWorkflowLogs(
  id: string,
  after = 0,
  limit = 200
): Promise<WorkflowLogsResponse> {
  const params = new URLSearchParams({
    after: String(after),
    limit: String(limit),
  });
  return apiRequest<WorkflowLogsResponse>(`/api/workflows/${id}/logs?${params.toString()}`);
}

export async function retryWorkflow(id: string): Promise<{ workflowId: string; status: string }> {
  return apiRequest<{ workflowId: string; status: string }>(`/api/workflows/${id}/retry`, {
    method: 'POST',
  });
}

export async function cancelWorkflow(
  id: string
): Promise<{ workflowId: string; status: string; cancelRequested: boolean }> {
  return apiRequest<{ workflowId: string; status: string; cancelRequested: boolean }>(
    `/api/workflows/${id}/cancel`,
    {
      method: 'POST',
    }
  );
}

// ─── CI & Deployments (Phase 3) ──────────────────────────────────────

export async function fetchServiceCiRuns(serviceId: string): Promise<CiRunItem[]> {
  const res = await apiRequest<ListCiRunsResponse>(`/api/services/${serviceId}/ci-runs`);
  return res.data;
}

export async function syncServiceCiRuns(serviceId: string): Promise<SyncCiRunsResponse> {
  return apiRequest<SyncCiRunsResponse>(`/api/services/${serviceId}/ci-runs/sync`, {
    method: 'POST',
  });
}

export async function fetchDeployableCommits(serviceId: string): Promise<DeployableCommitItem[]> {
  const res = await apiRequest<ListDeployableCommitsResponse>(
    `/api/services/${serviceId}/deployable-commits`
  );
  return res.data;
}

export async function fetchDeployments(
  query?: Partial<ListDeploymentsQuery>
): Promise<PaginatedResponse<DeploymentItem>> {
  const params = new URLSearchParams();
  if (query?.page) params.set('page', String(query.page));
  if (query?.pageSize) params.set('pageSize', String(query.pageSize));
  if (query?.status) params.set('status', query.status);
  if (query?.serviceId) params.set('serviceId', query.serviceId);
  if (query?.environment) params.set('environment', query.environment);

  const qs = params.toString();
  return apiRequest<PaginatedResponse<DeploymentItem>>(`/api/deployments${qs ? `?${qs}` : ''}`);
}

export async function fetchDeploymentById(id: string): Promise<DeploymentItem> {
  return apiRequest<DeploymentItem>(`/api/deployments/${id}`);
}

export async function fetchServiceDeployments(serviceId: string): Promise<DeploymentItem[]> {
  const res = await apiRequest<ListDeploymentsResponse>(`/api/services/${serviceId}/deployments`);
  return res.data;
}

export async function createDeployment(
  serviceId: string,
  input: DeployServiceInput
): Promise<DeployServiceResponse> {
  return apiRequest<DeployServiceResponse>(`/api/services/${serviceId}/deployments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function rollbackDeployment(
  deploymentId: string,
  input: RollbackDeploymentInput = { environment: 'development' }
): Promise<DeployServiceResponse> {
  return apiRequest<DeployServiceResponse>(`/api/deployments/${deploymentId}/rollback`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function undeployService(serviceId: string): Promise<UndeployServiceResponse> {
  return apiRequest<UndeployServiceResponse>(
    `/api/services/${serviceId}/environments/development/undeploy`,
    {
      method: 'POST',
    }
  );
}

export async function fetchUsers(): Promise<UserProfile[]> {
  const res = await apiRequest<ListUsersResponse>('/api/users');
  return res.data;
}

export async function updateUserRole(userId: string, role: UserRole): Promise<UserProfile> {
  return apiRequest<UserProfile>(`/api/users/${userId}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export async function updateServiceOwner(
  serviceId: string,
  ownerId: string
): Promise<ServiceDetail> {
  return apiRequest<ServiceDetail>(`/api/services/${serviceId}/owner`, {
    method: 'PATCH',
    body: JSON.stringify({ ownerId }),
  });
}

export async function fetchAuditLogs(
  query?: Partial<ListAuditLogsQuery>
): Promise<PaginatedResponse<AuditLogItem>> {
  const params = new URLSearchParams();
  if (query?.page) params.set('page', String(query.page));
  if (query?.pageSize) params.set('pageSize', String(query.pageSize));
  if (query?.action) params.set('action', query.action);
  if (query?.resourceType) params.set('resourceType', query.resourceType);
  if (query?.actorId) params.set('actorId', query.actorId);
  if (query?.from) params.set('from', query.from);
  if (query?.to) params.set('to', query.to);

  const qs = params.toString();
  return apiRequest<PaginatedResponse<AuditLogItem>>(`/api/audit-logs${qs ? `?${qs}` : ''}`);
}
