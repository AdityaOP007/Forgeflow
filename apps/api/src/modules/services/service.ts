import { db } from '../../db/client.js';
import {
  services,
  users,
  templates,
  environments,
  workflowRuns,
  auditLogs,
} from '../../db/schema.js';
import { eq, sql, ilike, and, desc, asc, count, inArray } from 'drizzle-orm';
import type {
  CreateServiceInput,
  UpdateServiceInput,
  ListServicesQuery,
  ServiceListItem,
  ServiceDetail,
  EnvironmentStatus,
  PaginatedResponse,
} from '@forgeflow/shared-types';
import { generateSlug } from '@forgeflow/shared-types';

// ─── Aggregate health from environments ──────────────────────────────
function aggregateHealth(envStatuses: EnvironmentStatus[]): EnvironmentStatus {
  if (envStatuses.length === 0) return 'unknown';
  if (envStatuses.some((s) => s === 'failed')) return 'failed';
  if (envStatuses.some((s) => s === 'degraded')) return 'degraded';
  if (envStatuses.some((s) => s === 'drifted')) return 'drifted';
  if (envStatuses.every((s) => s === 'healthy')) return 'healthy';
  return 'unknown';
}

// ─── List services ───────────────────────────────────────────────────
export async function listServices(
  query: ListServicesQuery
): Promise<PaginatedResponse<ServiceListItem>> {
  const { page, pageSize, search, owner, health, sort, order } = query;
  const offset = (page - 1) * pageSize;

  // Build where conditions
  const conditions = [];
  if (search) {
    conditions.push(ilike(services.name, `%${search}%`));
  }
  if (owner) {
    conditions.push(eq(services.owner_id, owner));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Sort column
  const sortCol = sort === 'name' ? services.name : services.created_at;
  const orderFn = order === 'asc' ? asc : desc;

  // Get total count
  const [{ value: total }] = await db.select({ value: count() }).from(services).where(whereClause);

  // Get paginated rows with owner and template joins
  const rows = await db
    .select({
      id: services.id,
      name: services.name,
      slug: services.slug,
      description: services.description,
      owner_id: services.owner_id,
      owner_name: users.name,
      repository_url: services.repository_url,
      template_id: services.template_id,
      template_name: templates.name,
      created_at: services.created_at,
      updated_at: services.updated_at,
    })
    .from(services)
    .leftJoin(users, eq(services.owner_id, users.id))
    .leftJoin(templates, eq(services.template_id, templates.id))
    .where(whereClause)
    .orderBy(orderFn(sortCol))
    .limit(pageSize)
    .offset(offset);

  // Get environments for all returned services to compute health
  const serviceIds = rows.map((r) => r.id);
  let envRows: { service_id: string; status: EnvironmentStatus }[] = [];
  if (serviceIds.length > 0) {
    envRows = (await db
      .select({ service_id: environments.service_id, status: environments.status })
      .from(environments)
      .where(inArray(environments.service_id, serviceIds))) as {
      service_id: string;
      status: EnvironmentStatus;
    }[];
  }

  // Group env statuses by service
  const envByService = new Map<string, EnvironmentStatus[]>();
  for (const e of envRows) {
    const arr = envByService.get(e.service_id) || [];
    arr.push(e.status);
    envByService.set(e.service_id, arr);
  }

  let data: ServiceListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    repositoryUrl: r.repository_url,
    templateId: r.template_id,
    templateName: r.template_name,
    health: aggregateHealth(envByService.get(r.id) || []),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));

  // Post-filter by health if requested
  if (health) {
    data = data.filter((s) => s.health === health);
  }

  return {
    data,
    total: Number(total),
    page,
    pageSize,
    totalPages: Math.ceil(Number(total) / pageSize),
  };
}

// ─── Get service by ID ───────────────────────────────────────────────
export async function getServiceById(id: string): Promise<ServiceDetail | null> {
  const row = await db
    .select({
      id: services.id,
      name: services.name,
      slug: services.slug,
      description: services.description,
      owner_id: services.owner_id,
      owner_name: users.name,
      repository_url: services.repository_url,
      template_id: services.template_id,
      template_name: templates.name,
      created_at: services.created_at,
      updated_at: services.updated_at,
    })
    .from(services)
    .leftJoin(users, eq(services.owner_id, users.id))
    .leftJoin(templates, eq(services.template_id, templates.id))
    .where(eq(services.id, id))
    .limit(1);

  if (row.length === 0) return null;

  const r = row[0];

  // Get environments
  const envs = await db.select().from(environments).where(eq(environments.service_id, id));

  // Get recent workflow runs (last 20)
  const runs = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.service_id, id))
    .orderBy(desc(workflowRuns.started_at))
    .limit(20);

  const envStatuses = envs.map((e) => e.status as EnvironmentStatus);

  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    repositoryUrl: r.repository_url,
    templateId: r.template_id,
    templateName: r.template_name,
    health: aggregateHealth(envStatuses),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    environments: envs.map((e) => ({
      id: e.id,
      serviceId: e.service_id,
      name: e.name as ServiceDetail['environments'][number]['name'],
      cluster: e.cluster,
      namespace: e.namespace,
      deployedVersion: e.deployed_version,
      status: e.status as EnvironmentStatus,
    })),
    workflowRuns: runs.map((w) => ({
      id: w.id,
      serviceId: w.service_id,
      type: w.type,
      status: w.status as ServiceDetail['workflowRuns'][number]['status'],
      externalRunId: w.external_run_id,
      startedAt: w.started_at?.toISOString() ?? null,
      completedAt: w.completed_at?.toISOString() ?? null,
      errorSummary: w.error_summary,
    })),
  };
}

// ─── Create service ──────────────────────────────────────────────────
export async function createService(
  input: CreateServiceInput,
  ownerId: string
): Promise<ServiceDetail> {
  const slug = generateSlug(input.name);

  // Check slug uniqueness
  const existing = await db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.slug, slug))
    .limit(1);

  if (existing.length > 0) {
    const err = new Error(`Service with slug '${slug}' already exists`);
    (err as Error & { statusCode: number }).statusCode = 409;
    throw err;
  }

  const [created] = await db
    .insert(services)
    .values({
      name: input.name,
      slug,
      description: input.description || null,
      owner_id: ownerId,
      repository_url: input.repositoryUrl ? input.repositoryUrl : null,
      template_id: input.templateId ? input.templateId : null,
    })
    .returning();

  return (await getServiceById(created.id))!;
}

// ─── Update service ──────────────────────────────────────────────────
export async function updateService(
  id: string,
  input: UpdateServiceInput
): Promise<ServiceDetail | null> {
  const updateData: Record<string, unknown> = { updated_at: new Date() };
  if (input.name !== undefined) {
    updateData.name = input.name;
    updateData.slug = generateSlug(input.name);

    // Check slug uniqueness (excluding self)
    const existing = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.slug, updateData.slug as string), sql`${services.id} != ${id}`))
      .limit(1);

    if (existing.length > 0) {
      const err = new Error(`Service with slug '${updateData.slug}' already exists`);
      (err as Error & { statusCode: number }).statusCode = 409;
      throw err;
    }
  }
  if (input.description !== undefined) updateData.description = input.description;
  if (input.repositoryUrl !== undefined) {
    updateData.repository_url = input.repositoryUrl ? input.repositoryUrl : null;
  }

  const [updated] = await db
    .update(services)
    .set(updateData)
    .where(eq(services.id, id))
    .returning();

  if (!updated) return null;
  return getServiceById(updated.id);
}

// ─── Delete service ──────────────────────────────────────────────────
export async function deleteService(id: string): Promise<boolean> {
  const result = await db
    .delete(services)
    .where(eq(services.id, id))
    .returning({ id: services.id });
  return result.length > 0;
}

// ─── Write audit log ────────────────────────────────────────────────
export async function writeAuditLog(
  actorId: string,
  action: string,
  resourceType: string,
  resourceId: string
): Promise<void> {
  await db.insert(auditLogs).values({
    actor_id: actorId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
  });
}
