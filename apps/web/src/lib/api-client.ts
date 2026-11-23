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
  options: RequestInit & { token?: string | null } = {}
): Promise<T> {
  const { token, headers, ...rest } = options;
  const url = `${API_BASE_URL}${path}`;

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
    throw new ApiError(res.status, message, errBody);
  }

  if (res.status === 204) {
    return null as T;
  }

  return res.json();
}

// ─── Typed API endpoints ─────────────────────────────────────────────

export async function fetchHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/health');
}

export async function fetchMe(token: string): Promise<UserProfile> {
  return apiRequest<UserProfile>('/api/me', { token });
}

export async function fetchDashboardSummary(token: string): Promise<DashboardSummary> {
  return apiRequest<DashboardSummary>('/api/dashboard/summary', { token });
}

export async function fetchServices(
  token: string,
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
  return apiRequest<PaginatedResponse<ServiceListItem>>(`/api/services${qs ? `?${qs}` : ''}`, {
    token,
  });
}

export async function fetchServiceById(token: string, id: string): Promise<ServiceDetail> {
  return apiRequest<ServiceDetail>(`/api/services/${id}`, { token });
}

export async function createService(
  token: string,
  input: CreateServiceInput
): Promise<ServiceDetail> {
  return apiRequest<ServiceDetail>('/api/services', {
    method: 'POST',
    token,
    body: JSON.stringify(input),
  });
}

export async function updateService(
  token: string,
  id: string,
  input: UpdateServiceInput
): Promise<ServiceDetail> {
  return apiRequest<ServiceDetail>(`/api/services/${id}`, {
    method: 'PATCH',
    token,
    body: JSON.stringify(input),
  });
}

export async function deleteService(token: string, id: string): Promise<void> {
  return apiRequest<void>(`/api/services/${id}`, {
    method: 'DELETE',
    token,
  });
}

export async function fetchTemplates(token: string): Promise<TemplateItem[]> {
  return apiRequest<TemplateItem[]>('/api/templates', { token });
}
