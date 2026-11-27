CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'in_progress', 'succeeded', 'failed', 'cancelled', 'rolled_back');--> statement-breakpoint
CREATE TABLE "ci_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"github_run_id" bigint NOT NULL,
	"run_attempt" integer DEFAULT 1 NOT NULL,
	"head_sha" text NOT NULL,
	"head_branch" text,
	"event" text,
	"status" text NOT NULL,
	"conclusion" text,
	"html_url" text,
	"jobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_runs_service_run_attempt_unique" UNIQUE("service_id","github_run_id","run_attempt")
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"workflow_run_id" uuid,
	"commit_sha" text NOT NULL,
	"image" text NOT NULL,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"rollback_of" uuid,
	"triggered_by" uuid,
	"helm_revision" integer,
	"error_summary" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_commit_sha_check" CHECK ("deployments"."commit_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"repository" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	CONSTRAINT "webhook_deliveries_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "node_port" integer;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "deployed_image" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "deployed_commit_sha" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "observed_image" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "observed_replicas" integer;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "observed_ready_replicas" integer;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "last_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "last_observed_error" text;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_runs_service_id_head_sha_idx" ON "ci_runs" USING btree ("service_id","head_sha");--> statement-breakpoint
CREATE INDEX "ci_runs_service_id_started_at_idx" ON "ci_runs" USING btree ("service_id","run_started_at");--> statement-breakpoint
CREATE INDEX "deployments_service_id_created_at_idx" ON "deployments" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_environment_id_created_at_idx" ON "deployments" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_env_active_unique" ON "deployments" USING btree ("environment_id") WHERE status IN ('queued', 'in_progress');--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_node_port_unique" UNIQUE("node_port");--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_node_port_check" CHECK ("environments"."node_port" IS NULL OR ("environments"."node_port" >= 30080 AND "environments"."node_port" <= 30089));