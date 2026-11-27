import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  unique,
  uniqueIndex,
  index,
  jsonb,
  integer,
  bigint,
  boolean,
  bigserial,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { CiJobItem } from '@forgeflow/shared-types';

// Enums
export const userRoleEnum = pgEnum('user_role', ['admin', 'developer', 'viewer']);

export const environmentNameEnum = pgEnum('environment_name', [
  'development',
  'staging',
  'production',
]);

export const environmentStatusEnum = pgEnum('environment_status', [
  'unknown',
  'healthy',
  'degraded',
  'failed',
  'drifted',
]);

export const workflowRunStatusEnum = pgEnum('workflow_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export const serviceProvisioningStatusEnum = pgEnum('service_provisioning_status', [
  'provisioning',
  'ready',
  'failed',
]);

export const workflowStepStatusEnum = pgEnum('workflow_step_status', [
  'waiting',
  'running',
  'succeeded',
  'failed',
  'skipped',
]);

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'queued',
  'in_progress',
  'succeeded',
  'failed',
  'cancelled',
  'rolled_back',
]);

// 1. Users table
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  clerk_id: text('clerk_id').unique().notNull(),
  name: text('name'),
  email: text('email').unique().notNull(),
  role: userRoleEnum('role').default('viewer').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2. Templates table
export const templates = pgTable('templates', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  language: text('language').notNull(),
  framework: text('framework').notNull(),
  version: text('version').notNull(),
  source_location: text('source_location').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 3. Services table
export const services = pgTable(
  'services',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').unique().notNull(),
    description: text('description'),
    owner_id: uuid('owner_id')
      .references(() => users.id)
      .notNull(),
    repository_url: text('repository_url'),
    template_id: uuid('template_id').references(() => templates.id),
    provisioning_status: serviceProvisioningStatusEnum('provisioning_status')
      .default('ready')
      .notNull(),
    template_version: text('template_version'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('services_owner_id_idx').on(table.owner_id),
    index('services_slug_idx').on(table.slug),
  ]
);

// 4. Environments table
export const environments = pgTable(
  'environments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    service_id: uuid('service_id')
      .references(() => services.id, { onDelete: 'cascade' })
      .notNull(),
    name: environmentNameEnum('name').notNull(),
    cluster: text('cluster'),
    namespace: text('namespace'),
    deployed_version: text('deployed_version'),
    status: environmentStatusEnum('status').default('unknown').notNull(),
    node_port: integer('node_port').unique(),
    url: text('url'),
    deployed_image: text('deployed_image'),
    deployed_commit_sha: text('deployed_commit_sha'),
    observed_image: text('observed_image'),
    observed_replicas: integer('observed_replicas'),
    observed_ready_replicas: integer('observed_ready_replicas'),
    last_observed_at: timestamp('last_observed_at', { withTimezone: true }),
    last_observed_error: text('last_observed_error'),
  },
  (table) => [
    unique('environments_service_name_unique').on(table.service_id, table.name),
    index('environments_service_id_idx').on(table.service_id),
    check(
      'environments_node_port_check',
      sql`${table.node_port} IS NULL OR (${table.node_port} >= 30080 AND ${table.node_port} <= 30089)`
    ),
  ]
);

// 5. Workflow Runs table
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    service_id: uuid('service_id')
      .references(() => services.id, { onDelete: 'cascade' })
      .notNull(),
    type: text('type').notNull(),
    status: workflowRunStatusEnum('status').notNull(),
    external_run_id: text('external_run_id'),
    input: jsonb('input').$type<Record<string, unknown>>().default({}).notNull(),
    resources: jsonb('resources').$type<Record<string, unknown>>().default({}).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    locked_at: timestamp('locked_at', { withTimezone: true }),
    locked_by: text('locked_by'),
    cancel_requested: boolean('cancel_requested').default(false).notNull(),
    created_by: uuid('created_by').references(() => users.id),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    error_summary: text('error_summary'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('workflow_runs_service_id_idx').on(table.service_id),
    index('workflow_runs_status_created_at_idx').on(table.status, table.created_at),
    index('workflow_runs_service_id_created_at_idx').on(table.service_id, table.created_at),
  ]
);

// 6. Workflow Steps table
export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workflow_run_id: uuid('workflow_run_id')
      .references(() => workflowRuns.id, { onDelete: 'cascade' })
      .notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    status: workflowStepStatusEnum('status').default('waiting').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    error_summary: text('error_summary'),
  },
  (table) => [
    unique('workflow_steps_run_key_unique').on(table.workflow_run_id, table.key),
    index('workflow_steps_workflow_run_id_idx').on(table.workflow_run_id),
  ]
);

// 7. Workflow Logs table
export const workflowLogs = pgTable(
  'workflow_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workflow_run_id: uuid('workflow_run_id')
      .references(() => workflowRuns.id, { onDelete: 'cascade' })
      .notNull(),
    step_key: text('step_key'),
    level: text('level').notNull(), // 'info' | 'warn' | 'error'
    message: text('message').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('workflow_logs_run_id_id_idx').on(table.workflow_run_id, table.id)]
);

// 8. Audit Logs table
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actor_id: uuid('actor_id')
      .references(() => users.id)
      .notNull(),
    action: text('action').notNull(),
    resource_type: text('resource_type').notNull(),
    resource_id: text('resource_id').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('audit_logs_timestamp_idx').on(table.timestamp)]
);

// 9. Deployments table
export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    service_id: uuid('service_id')
      .references(() => services.id, { onDelete: 'cascade' })
      .notNull(),
    environment_id: uuid('environment_id')
      .references(() => environments.id, { onDelete: 'cascade' })
      .notNull(),
    workflow_run_id: uuid('workflow_run_id').references(() => workflowRuns.id, {
      onDelete: 'set null',
    }),
    commit_sha: text('commit_sha').notNull(),
    image: text('image').notNull(),
    status: deploymentStatusEnum('status').default('queued').notNull(),
    rollback_of: uuid('rollback_of'),
    triggered_by: uuid('triggered_by').references(() => users.id),
    helm_revision: integer('helm_revision'),
    error_summary: text('error_summary'),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('deployments_service_id_created_at_idx').on(table.service_id, table.created_at),
    index('deployments_environment_id_created_at_idx').on(table.environment_id, table.created_at),
    uniqueIndex('deployments_env_active_unique')
      .on(table.environment_id)
      .where(sql`status IN ('queued', 'in_progress')`),
    check('deployments_commit_sha_check', sql`${table.commit_sha} ~ '^[0-9a-f]{40}$'`),
  ]
);

// 10. CI Runs table
export const ciRuns = pgTable(
  'ci_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    service_id: uuid('service_id')
      .references(() => services.id, { onDelete: 'cascade' })
      .notNull(),
    github_run_id: bigint('github_run_id', { mode: 'number' }).notNull(),
    run_attempt: integer('run_attempt').default(1).notNull(),
    head_sha: text('head_sha').notNull(),
    head_branch: text('head_branch'),
    event: text('event'),
    status: text('status').notNull(),
    conclusion: text('conclusion'),
    html_url: text('html_url'),
    jobs: jsonb('jobs').$type<CiJobItem[]>().default([]).notNull(),
    run_started_at: timestamp('run_started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('ci_runs_service_run_attempt_unique').on(
      table.service_id,
      table.github_run_id,
      table.run_attempt
    ),
    index('ci_runs_service_id_head_sha_idx').on(table.service_id, table.head_sha),
    index('ci_runs_service_id_started_at_idx').on(table.service_id, table.run_started_at),
  ]
);

// 11. Webhook Deliveries table
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),
  delivery_id: text('delivery_id').unique().notNull(),
  event: text('event').notNull(),
  repository: text('repository'),
  received_at: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  processed_at: timestamp('processed_at', { withTimezone: true }),
  status: text('status').default('received').notNull(),
  error: text('error'),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  services: many(services),
  auditLogs: many(auditLogs),
  createdWorkflowRuns: many(workflowRuns),
}));

export const templatesRelations = relations(templates, ({ many }) => ({
  services: many(services),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  owner: one(users, {
    fields: [services.owner_id],
    references: [users.id],
  }),
  template: one(templates, {
    fields: [services.template_id],
    references: [templates.id],
  }),
  environments: many(environments),
  workflowRuns: many(workflowRuns),
}));

export const environmentsRelations = relations(environments, ({ one }) => ({
  service: one(services, {
    fields: [environments.service_id],
    references: [services.id],
  }),
}));

export const workflowRunsRelations = relations(workflowRuns, ({ one, many }) => ({
  service: one(services, {
    fields: [workflowRuns.service_id],
    references: [services.id],
  }),
  creator: one(users, {
    fields: [workflowRuns.created_by],
    references: [users.id],
  }),
  steps: many(workflowSteps),
  logs: many(workflowLogs),
}));

export const workflowStepsRelations = relations(workflowSteps, ({ one }) => ({
  workflowRun: one(workflowRuns, {
    fields: [workflowSteps.workflow_run_id],
    references: [workflowRuns.id],
  }),
}));

export const workflowLogsRelations = relations(workflowLogs, ({ one }) => ({
  workflowRun: one(workflowRuns, {
    fields: [workflowLogs.workflow_run_id],
    references: [workflowRuns.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  actor: one(users, {
    fields: [auditLogs.actor_id],
    references: [users.id],
  }),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  service: one(services, {
    fields: [deployments.service_id],
    references: [services.id],
  }),
  environment: one(environments, {
    fields: [deployments.environment_id],
    references: [environments.id],
  }),
  workflowRun: one(workflowRuns, {
    fields: [deployments.workflow_run_id],
    references: [workflowRuns.id],
  }),
  triggeredByUser: one(users, {
    fields: [deployments.triggered_by],
    references: [users.id],
  }),
}));

export const ciRunsRelations = relations(ciRuns, ({ one }) => ({
  service: one(services, {
    fields: [ciRuns.service_id],
    references: [services.id],
  }),
}));
