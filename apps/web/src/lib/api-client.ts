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
} from '@forgeflow/shared-types';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

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
      const res = await fetch(url, {
        ...rest,
        headers: {
          'Content-Type': 'application/json',
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
