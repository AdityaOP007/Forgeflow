import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  listWorkflowsQuerySchema,
  workflowLogsQuerySchema,
  type PaginatedResponse,
  type WorkflowDetailResponse,
  type WorkflowListItem,
  type WorkflowLogsResponse,
  type WorkflowRunStatus,
  type WorkflowStepStatus,
} from '@forgeflow/shared-types';
import { and, asc, count, desc, eq, gt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { services, workflowLogs, workflowRuns, workflowSteps } from '../../db/schema.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { requestCancel, retry } from '../../workflows/queue.js';
import { TransitionConflictError, WorkflowTerminalError } from '../../workflows/state-machine.js';
import { writeAuditLog } from '../services/service.js';

export const workflowsRouter = Router();

async function loadWorkflowDetail(id: string): Promise<WorkflowDetailResponse | null> {
  const [row] = await db
    .select({
      run: workflowRuns,
      serviceName: services.name,
      serviceSlug: services.slug,
    })
    .from(workflowRuns)
    .innerJoin(services, eq(workflowRuns.service_id, services.id))
    .where(eq(workflowRuns.id, id))
    .limit(1);

  if (!row) return null;

  const steps = await db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.workflow_run_id, id))
    .orderBy(asc(workflowSteps.position));

  const failedStep = steps.find((s) => s.status === 'failed');

  return {
    id: row.run.id,
    serviceId: row.run.service_id,
    serviceName: row.serviceName,
    serviceSlug: row.serviceSlug,
    type: row.run.type,
    status: row.run.status as WorkflowRunStatus,
    input: row.run.input,
    resources: row.run.resources,
    attempts: row.run.attempts,
    lockedAt: row.run.locked_at?.toISOString() ?? null,
    lockedBy: row.run.locked_by,
    cancelRequested: row.run.cancel_requested,
    createdBy: row.run.created_by,
    startedAt: row.run.started_at?.toISOString() ?? null,
    completedAt: row.run.completed_at?.toISOString() ?? null,
    errorSummary: row.run.error_summary,
    createdAt: row.run.created_at.toISOString(),
    failedStepKey: failedStep?.key ?? null,
    steps: steps.map((s) => ({
      id: s.id,
      workflowRunId: s.workflow_run_id,
      key: s.key,
      name: s.name,
      position: s.position,
      status: s.status as WorkflowStepStatus,
      startedAt: s.started_at?.toISOString() ?? null,
      completedAt: s.completed_at?.toISOString() ?? null,
      errorSummary: s.error_summary,
    })),
  };
}

// GET /api/workflows — paginated list, newest first
workflowsRouter.get(
  '/',
  validate(listWorkflowsQuerySchema, 'query'),
  async (req: Request, res: Response<PaginatedResponse<WorkflowListItem>>, next: NextFunction) => {
    try {
      const { page, pageSize, status, type, serviceId } = req.query as unknown as {
        page: number;
        pageSize: number;
        status?: WorkflowRunStatus;
        type?: 'scaffold' | 'deploy' | 'undeploy';
        serviceId?: string;
      };
      const offset = (page - 1) * pageSize;

      const conditions = [];
      if (status) conditions.push(eq(workflowRuns.status, status));
      if (type) conditions.push(eq(workflowRuns.type, type));
      if (serviceId) conditions.push(eq(workflowRuns.service_id, serviceId));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [{ value: total }] = await db
        .select({ value: count() })
        .from(workflowRuns)
        .where(whereClause);

      const rows = await db
        .select({
          run: workflowRuns,
          serviceName: services.name,
          serviceSlug: services.slug,
        })
        .from(workflowRuns)
        .innerJoin(services, eq(workflowRuns.service_id, services.id))
        .where(whereClause)
        .orderBy(desc(workflowRuns.created_at))
        .limit(pageSize)
        .offset(offset);

      const data: WorkflowListItem[] = rows.map((r) => ({
        id: r.run.id,
        serviceId: r.run.service_id,
        serviceName: r.serviceName,
        serviceSlug: r.serviceSlug,
        type: r.run.type,
        status: r.run.status as WorkflowRunStatus,
        attempts: r.run.attempts,
        cancelRequested: r.run.cancel_requested,
        startedAt: r.run.started_at?.toISOString() ?? null,
        completedAt: r.run.completed_at?.toISOString() ?? null,
        createdAt: r.run.created_at.toISOString(),
        errorSummary: r.run.error_summary,
      }));

      res.json({
        data,
        total: Number(total),
        page,
        pageSize,
        totalPages: Math.ceil(Number(total) / pageSize),
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/workflows/:id — workflow detail
workflowsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const detail = await loadWorkflowDetail(req.params.id);
    if (!detail) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Workflow run not found' },
      });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// GET /api/workflows/:id/logs — incremental ascending logs
workflowsRouter.get(
  '/:id/logs',
  validate(workflowLogsQuerySchema, 'query'),
  async (
    req: Request,
    res: Response<WorkflowLogsResponse | { error: unknown }>,
    next: NextFunction
  ) => {
    try {
      const [exists] = await db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, req.params.id))
        .limit(1);

      if (!exists) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Workflow run not found' },
        });
        return;
      }

      const { after, limit } = req.query as unknown as { after: number; limit: number };

      const rows = await db
        .select()
        .from(workflowLogs)
        .where(and(eq(workflowLogs.workflow_run_id, req.params.id), gt(workflowLogs.id, after)))
        .orderBy(asc(workflowLogs.id))
        .limit(limit);

      const logs = rows.map((r) => ({
        id: r.id,
        workflowRunId: r.workflow_run_id,
        stepKey: r.step_key,
        level: r.level as 'info' | 'warn' | 'error',
        message: r.message,
        createdAt: r.created_at.toISOString(),
      }));

      const nextCursor = logs.length > 0 ? logs[logs.length - 1].id : null;
      res.json({ logs, nextCursor });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/workflows/:id/cancel — owner or admin
workflowsRouter.post(
  '/:id/cancel',
  requireRole('developer', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [row] = await db
        .select({
          runId: workflowRuns.id,
          ownerId: services.owner_id,
        })
        .from(workflowRuns)
        .innerJoin(services, eq(workflowRuns.service_id, services.id))
        .where(eq(workflowRuns.id, req.params.id))
        .limit(1);

      if (!row) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Workflow run not found' },
        });
        return;
      }

      if (req.auth!.role !== 'admin' && row.ownerId !== req.auth!.userId) {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Only the service owner or an admin can cancel this workflow',
          },
        });
        return;
      }

      const cancelResult = await requestCancel(req.params.id);
      await writeAuditLog(req.auth!.userId!, 'workflow.cancel', 'workflow_run', req.params.id);
      const detail = await loadWorkflowDetail(req.params.id);
      res.json({
        workflowId: req.params.id,
        status: detail?.status ?? (cancelResult.cancelled ? 'cancelled' : 'running'),
        cancelled: cancelResult.cancelled,
        immediate: cancelResult.immediate,
        cancelRequested: detail?.cancelRequested ?? true,
      });
    } catch (err) {
      if (err instanceof WorkflowTerminalError) {
        res.status(409).json({
          error: { code: 'CONFLICT', message: err.message },
        });
        return;
      }
      next(err);
    }
  }
);

// POST /api/workflows/:id/retry — owner or admin
workflowsRouter.post(
  '/:id/retry',
  requireRole('developer', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [row] = await db
        .select({
          runId: workflowRuns.id,
          ownerId: services.owner_id,
        })
        .from(workflowRuns)
        .innerJoin(services, eq(workflowRuns.service_id, services.id))
        .where(eq(workflowRuns.id, req.params.id))
        .limit(1);

      if (!row) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Workflow run not found' },
        });
        return;
      }

      if (req.auth!.role !== 'admin' && row.ownerId !== req.auth!.userId) {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Only the service owner or an admin can retry this workflow',
          },
        });
        return;
      }

      await retry(req.params.id);
      await writeAuditLog(req.auth!.userId!, 'workflow.retry', 'workflow_run', req.params.id);
      res.json({
        workflowId: req.params.id,
        status: 'queued',
      });
    } catch (err) {
      if (err instanceof TransitionConflictError) {
        res.status(409).json({
          error: { code: 'CONFLICT', message: err.message },
        });
        return;
      }
      next(err);
    }
  }
);
