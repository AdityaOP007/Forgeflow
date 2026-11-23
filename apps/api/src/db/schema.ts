import { pgTable, uuid, text, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
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
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    error_summary: text('error_summary'),
  },
  (table) => [index('workflow_runs_service_id_idx').on(table.service_id)]
);

// 6. Audit Logs table
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

export const workflowRunsRelations = relations(workflowRuns, ({ one }) => ({
  service: one(services, {
    fields: [workflowRuns.service_id],
    references: [services.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  actor: one(users, {
    fields: [auditLogs.actor_id],
    references: [users.id],
  }),
}));
