CREATE TYPE "public"."service_provisioning_status" AS ENUM('provisioning', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workflow_step_status" AS ENUM('waiting', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "workflow_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"step_key" text,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"status" "workflow_step_status" DEFAULT 'waiting' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_summary" text,
	CONSTRAINT "workflow_steps_run_key_unique" UNIQUE("workflow_run_id","key")
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "provisioning_status" "service_provisioning_status" DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "template_version" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "input" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "resources" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "cancel_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_logs" ADD CONSTRAINT "workflow_logs_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_logs_run_id_id_idx" ON "workflow_logs" USING btree ("workflow_run_id","id");--> statement-breakpoint
CREATE INDEX "workflow_steps_workflow_run_id_idx" ON "workflow_steps" USING btree ("workflow_run_id");--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_runs_status_created_at_idx" ON "workflow_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_service_id_created_at_idx" ON "workflow_runs" USING btree ("service_id","created_at");