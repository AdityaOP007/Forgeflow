import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  unique,
  index,
  jsonb,
  integer,
  boolean,
  bigserial,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

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
  },
  (table) => [
    unique('environments_service_name_unique').on(table.service_id, table.name),
    index('environments_service_id_idx').on(table.service_id),
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
