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
  ScaffoldServiceInput,
  ScaffoldServiceResponse,
  ListServicesQuery,
  ServiceListItem,
  ServiceDetail,
  ServiceProvisioningStatus,
  EnvironmentStatus,
  PaginatedResponse,
} from '@forgeflow/shared-types';
import { generateSlug } from '@forgeflow/shared-types';
import { getGitHubConfig } from '../../config/env.js';
import { isTemplateAvailable } from '../../templates/registry.js';
import { enqueue } from '../../workflows/queue.js';
import { SCAFFOLD_STEP_DEFINITIONS } from '../../workflows/steps/scaffold.js';

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
      provisioning_status: services.provisioning_status,
      template_version: services.template_version,
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

  // Get environments and latest workflow run for all returned services
  const serviceIds = rows.map((r) => r.id);
  let envRows: { service_id: string; status: EnvironmentStatus }[] = [];
  const latestWorkflowByService = new Map<string, string>();
  if (serviceIds.length > 0) {
    envRows = (await db
      .select({ service_id: environments.service_id, status: environments.status })
      .from(environments)
      .where(inArray(environments.service_id, serviceIds))) as {
      service_id: string;
      status: EnvironmentStatus;
    }[];

    const wfRows = await db
      .select({ id: workflowRuns.id, service_id: workflowRuns.service_id })
      .from(workflowRuns)
      .where(inArray(workflowRuns.service_id, serviceIds))
      .orderBy(desc(workflowRuns.created_at));
    for (const w of wfRows) {
      if (!latestWorkflowByService.has(w.service_id)) {
        latestWorkflowByService.set(w.service_id, w.id);
      }
    }
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
    provisioningStatus: r.provisioning_status as ServiceProvisioningStatus,
    templateVersion: r.template_version,
    latestWorkflowId: latestWorkflowByService.get(r.id) ?? null,
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
      provisioning_status: services.provisioning_status,
      template_version: services.template_version,
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

  // Get recent workflow runs (last 20, newest first)
  const runs = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.service_id, id))
    .orderBy(desc(workflowRuns.created_at))
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
    provisioningStatus: r.provisioning_status as ServiceProvisioningStatus,
    templateVersion: r.template_version,
    latestWorkflowId: runs[0]?.id ?? null,
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
      nodePort: e.node_port,
      url: e.url,
      deployedImage: e.deployed_image,
      deployedCommitSha: e.deployed_commit_sha,
      observedImage: e.observed_image,
      observedReplicas: e.observed_replicas,
      observedReadyReplicas: e.observed_ready_replicas,
      lastObservedAt: e.last_observed_at?.toISOString() ?? null,
      lastObservedError: e.last_observed_error,
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

// ─── Scaffold service (async workflow) ───────────────────────────────
export async function scaffoldService(
  input: ScaffoldServiceInput,
  ownerId: string,
  isGitHubConfigured: () => boolean = () => getGitHubConfig().configured
): Promise<ScaffoldServiceResponse> {
  if (!isGitHubConfigured()) {
    const err = new Error(
      'GitHub App integration is not configured. See docs/github-app-setup.md to configure credentials.'
    ) as Error & { statusCode: number; code: string };
    err.statusCode = 503;
    err.code = 'GITHUB_NOT_CONFIGURED';
    throw err;
  }

  const [tpl] = await db
    .select()
    .from(templates)
    .where(eq(templates.id, input.templateId))
    .limit(1);

  if (!tpl || !isTemplateAvailable(tpl.slug)) {
    const err = new Error('Selected template is not available') as Error & {
      statusCode: number;
      code: string;
    };
    err.statusCode = 422;
    err.code = 'TEMPLATE_UNAVAILABLE';
    throw err;
  }

  const slug = generateSlug(input.name);

  return db.transaction(async (tx) => {
    // Limit active workflows per user (3 queued or running)
    const [{ value: activeCount }] = await tx
      .select({ value: count() })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.created_by, ownerId),
          inArray(workflowRuns.status, ['queued', 'running'])
        )
      );

    if (Number(activeCount) >= 3) {
      const err = new Error(
        'Too many active workflows: you already have 3 workflows queued or running'
      ) as Error & { statusCode: number; code: string };
      err.statusCode = 429;
      err.code = 'TOO_MANY_ACTIVE_WORKFLOWS';
      throw err;
    }

    // Check slug uniqueness
    const existing = await tx
      .select({ id: services.id })
      .from(services)
      .where(eq(services.slug, slug))
      .limit(1);

    if (existing.length > 0) {
      const err = new Error(`Service with slug '${slug}' already exists`) as Error & {
        statusCode: number;
        code: string;
      };
      err.statusCode = 409;
      err.code = 'CONFLICT';
      throw err;
    }

    const [createdService] = await tx
      .insert(services)
      .values({
        name: input.name,
        slug,
        description: input.description || null,
        owner_id: ownerId,
        template_id: tpl.id,
        provisioning_status: 'provisioning',
      })
      .returning();

    const { run } = await enqueue(
      {
        serviceId: createdService.id,
        type: 'scaffold',
        input: input as unknown as Record<string, unknown>,
        createdBy: ownerId,
        steps: [...SCAFFOLD_STEP_DEFINITIONS],
      },
      tx
    );

    await tx.insert(auditLogs).values({
      actor_id: ownerId,
      action: 'service.scaffold.requested',
      resource_type: 'service',
      resource_id: createdService.id,
    });

    return {
      serviceId: createdService.id,
      workflowId: run.id,
      status: 'queued',
    };
  });
}

// ─── Delete service ──────────────────────────────────────────────────
export async function deleteService(id: string): Promise<boolean> {
  const activeRuns = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(eq(workflowRuns.service_id, id), inArray(workflowRuns.status, ['queued', 'running']))
    )
    .limit(1);

  if (activeRuns.length > 0) {
    const err = new Error(
      'Cannot delete service while a workflow is queued or running'
    ) as Error & { statusCode: number; code: string };
    err.statusCode = 409;
    err.code = 'WORKFLOW_IN_PROGRESS';
    throw err;
  }

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
