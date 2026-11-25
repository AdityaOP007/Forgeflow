import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DashboardSummary } from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { services, environments, workflowRuns } from '../../db/schema.js';
import { count, eq, and, gte, inArray } from 'drizzle-orm';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/summary',
  async (_req: Request, res: Response<DashboardSummary>, next: NextFunction) => {
    try {
      // Total services
      const [{ value: totalServices }] = await db.select({ value: count() }).from(services);

      // Get all environment statuses
      const envStatuses = await db
        .select({
          service_id: environments.service_id,
          status: environments.status,
        })
        .from(environments);

      // Group by service to compute per-service health
      const serviceHealth = new Map<string, string[]>();
      for (const e of envStatuses) {
        const arr = serviceHealth.get(e.service_id) || [];
        arr.push(e.status);
        serviceHealth.set(e.service_id, arr);
      }

      let healthyCount = 0;
      let unhealthyCount = 0;
      for (const [, statuses] of serviceHealth) {
        const hasFailed = statuses.some((s) => s === 'failed');
        const hasDegraded = statuses.some((s) => s === 'degraded');
        const hasDrifted = statuses.some((s) => s === 'drifted');
        const allHealthy = statuses.every((s) => s === 'healthy');

        if (hasFailed || hasDegraded || hasDrifted) {
          unhealthyCount++;
        } else if (allHealthy) {
          healthyCount++;
        }
      }

      // Unknown = total services minus services with known health
      const unknownCount = Number(totalServices) - healthyCount - unhealthyCount;

      // Active deployments (workflow_runs with status 'running')
      const [{ value: activeDeployments }] = await db
        .select({ value: count() })
        .from(workflowRuns)
        .where(eq(workflowRuns.status, 'running'));

      // Active workflows (queued + running)
      const [{ value: activeWorkflows }] = await db
        .select({ value: count() })
        .from(workflowRuns)
        .where(inArray(workflowRuns.status, ['queued', 'running']));

      // Failed builds in last 24h
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [{ value: failedBuilds }] = await db
        .select({ value: count() })
        .from(workflowRuns)
        .where(
          and(eq(workflowRuns.status, 'failed'), gte(workflowRuns.created_at, twentyFourHoursAgo))
        );

      res.json({
        totalServices: Number(totalServices),
        healthyCount,
        unhealthyCount,
        unknownCount,
        activeDeployments: Number(activeDeployments),
        failedBuilds: Number(failedBuilds),
        activeWorkflows: Number(activeWorkflows),
      });
    } catch (err) {
      next(err);
    }
  }
);
