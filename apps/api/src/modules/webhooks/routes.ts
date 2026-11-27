import crypto from 'crypto';
import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../../db/client.js';
import { ciRuns, services, webhookDeliveries } from '../../db/schema.js';
import { and, eq, sql } from 'drizzle-orm';
import type { CiJobItem } from '@forgeflow/shared-types';
import { getEnv } from '../../config/env.js';
import { redactSecrets } from '../../utils/redact.js';

export interface WebhooksRouterOptions {
  getWebhookSecret?: () => string | undefined;
}

const MAX_WEBHOOK_BYTES = 256 * 1024; // 256 kb

/**
 * Verifies GitHub's X-Hub-Signature-256 header using HMAC-SHA256 and timing-safe comparison
 * after an explicit byte-length check.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const providedHex = signatureHeader.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) {
    return false;
  }
  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(providedHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

async function findServiceByWebhookRepo(repo?: {
  html_url?: string;
  full_name?: string;
}): Promise<typeof services.$inferSelect | null> {
  if (!repo) return null;
  const candidates: string[] = [];
  if (repo.html_url) {
    candidates.push(repo.html_url.replace(/\/+$/, '').toLowerCase());
  }
  if (repo.full_name) {
    candidates.push(`https://github.com/${repo.full_name}`.toLowerCase());
  }
  if (candidates.length === 0) return null;

  const allServices = await db
    .select()
    .from(services)
    .where(sql`${services.repository_url} IS NOT NULL`);

  return (
    allServices.find((s) => {
      if (!s.repository_url) return false;
      const normalized = s.repository_url
        .trim()
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '')
        .toLowerCase();
      return candidates.includes(normalized);
    }) ?? null
  );
}

interface WorkflowRunPayload {
  repository?: { html_url?: string; full_name?: string };
  workflow_run?: {
    id: number;
    run_attempt?: number;
    head_sha: string;
    head_branch?: string | null;
    event?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    run_started_at?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  };
}

interface WorkflowJobPayload {
  repository?: { html_url?: string; full_name?: string };
  workflow_job?: {
    id: number;
    run_id: number;
    run_attempt?: number;
    head_sha?: string;
    name: string;
    status: string;
    conclusion?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    html_url?: string | null;
  };
}

async function markDelivery(
  deliveryId: string,
  status: 'processed' | 'ignored' | 'failed',
  error?: string
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status,
      processed_at: new Date(),
      error: error ? redactSecrets(error) : null,
    })
    .where(eq(webhookDeliveries.delivery_id, deliveryId));
}

export function createWebhooksRouter(options: WebhooksRouterOptions = {}): Router {
  const router = Router();
  const getWebhookSecret = options.getWebhookSecret ?? (() => getEnv().GITHUB_WEBHOOK_SECRET);

  // Separate rate limit for webhooks: 60 requests per minute
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many webhook requests, please try again later',
      },
    },
  });

  const rawJsonParser = express.raw({ type: 'application/json', limit: MAX_WEBHOOK_BYTES });

  router.post(
    '/github',
    webhookLimiter,
    // 1. Secret configuration & Content-Type check before body parsing
    (req: Request, res: Response, next: NextFunction) => {
      if (!getWebhookSecret()) {
        res.status(503).json({
          error: {
            code: 'WEBHOOK_NOT_CONFIGURED',
            message: 'GitHub webhook secret is not configured',
          },
        });
        return;
      }
      if (!req.is('application/json')) {
        res.status(415).json({
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'Content-Type must be application/json',
          },
        });
        return;
      }
      rawJsonParser(req, res, (err?: unknown) => {
        if (err) {
          const status =
            (err as { status?: number; statusCode?: number })?.status ??
            (err as { statusCode?: number })?.statusCode;
          if (status === 413 || (err as { type?: string })?.type === 'entity.too.large') {
            res.status(413).json({
              error: {
                code: 'PAYLOAD_TOO_LARGE',
                message: 'Webhook payload exceeds 256kb limit',
              },
            });
            return;
          }
          next(err);
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      const secret = getWebhookSecret()!;
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      // 2. Verify HMAC-SHA256 signature BEFORE any database access
      const signature = req.header('x-hub-signature-256');
      if (!verifyGitHubSignature(rawBody, signature, secret)) {
        res.status(401).json({
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Invalid GitHub webhook signature',
          },
        });
        return;
      }

      const event = req.header('x-github-event');
      const deliveryId = req.header('x-github-delivery');
      if (!event || !deliveryId) {
        res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: 'Missing required X-GitHub-Event or X-GitHub-Delivery header',
          },
        });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      } catch {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' },
        });
        return;
      }

      const repoObj = payload.repository as { html_url?: string; full_name?: string } | undefined;

      // 3. Idempotency guard via unique delivery_id
      const inserted = await db
        .insert(webhookDeliveries)
        .values({
          delivery_id: deliveryId,
          event,
          repository: repoObj?.full_name ?? null,
          status: 'received',
        })
        .onConflictDoNothing({ target: webhookDeliveries.delivery_id })
        .returning({ id: webhookDeliveries.id });

      if (inserted.length === 0) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      try {
        if (event === 'ping') {
          await markDelivery(deliveryId, 'processed');
          res.status(200).json({ ok: true, event: 'ping' });
          return;
        }

        if (event === 'workflow_run') {
          const data = payload as unknown as WorkflowRunPayload;
          const run = data.workflow_run;
          const svc = await findServiceByWebhookRepo(data.repository);
          if (!svc || !run) {
            await markDelivery(deliveryId, 'ignored');
            res.status(200).json({ ok: true, ignored: true });
            return;
          }

          const runAttempt = run.run_attempt ?? 1;
          const status = run.status ?? 'queued';
          const runStartedAt = run.run_started_at ?? run.created_at;
          const incomingUpdatedAt = run.updated_at ? new Date(run.updated_at) : new Date();
          const completedAt =
            status === 'completed'
              ? new Date(run.updated_at ? Date.parse(run.updated_at) : Date.now())
              : null;

          // Older-updated_at-never-overwrites-newer guard
          const [existing] = await db
            .select({ id: ciRuns.id, updated_at: ciRuns.updated_at })
            .from(ciRuns)
            .where(
              and(
                eq(ciRuns.service_id, svc.id),
                eq(ciRuns.github_run_id, run.id),
                eq(ciRuns.run_attempt, runAttempt)
              )
            )
            .limit(1);

          if (existing && existing.updated_at > incomingUpdatedAt) {
            await markDelivery(deliveryId, 'processed');
            res.status(200).json({ ok: true, stale: true });
            return;
          }

          await db
            .insert(ciRuns)
            .values({
              service_id: svc.id,
              github_run_id: run.id,
              run_attempt: runAttempt,
              head_sha: run.head_sha,
              head_branch: run.head_branch ?? null,
              event: run.event ?? 'push',
              status,
              conclusion: run.conclusion ?? null,
              html_url: run.html_url ?? null,
              jobs: [],
              run_started_at: runStartedAt ? new Date(runStartedAt) : null,
              completed_at: completedAt,
              updated_at: incomingUpdatedAt,
            })
            .onConflictDoUpdate({
              target: [ciRuns.service_id, ciRuns.github_run_id, ciRuns.run_attempt],
              set: {
                head_sha: run.head_sha,
                head_branch: run.head_branch ?? null,
                event: run.event ?? 'push',
                status,
                conclusion: run.conclusion ?? null,
                html_url: run.html_url ?? null,
                run_started_at: runStartedAt ? new Date(runStartedAt) : null,
                completed_at: completedAt,
                updated_at: incomingUpdatedAt,
              },
              where: sql`${ciRuns.updated_at} <= ${incomingUpdatedAt}`,
            });

          await markDelivery(deliveryId, 'processed');
          res.status(200).json({ ok: true, serviceId: svc.id, githubRunId: run.id });
          return;
        }

        if (event === 'workflow_job') {
          const data = payload as unknown as WorkflowJobPayload;
          const job = data.workflow_job;
          const svc = await findServiceByWebhookRepo(data.repository);
          if (!svc || !job) {
            await markDelivery(deliveryId, 'ignored');
            res.status(200).json({ ok: true, ignored: true });
            return;
          }

          const runAttempt = job.run_attempt ?? 1;
          const jobItem: CiJobItem = {
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion ?? null,
            startedAt: job.started_at ?? null,
            completedAt: job.completed_at ?? null,
            htmlUrl: job.html_url ?? null,
          };

          const [existing] = await db
            .select()
            .from(ciRuns)
            .where(
              and(
                eq(ciRuns.service_id, svc.id),
                eq(ciRuns.github_run_id, job.run_id),
                eq(ciRuns.run_attempt, runAttempt)
              )
            )
            .limit(1);

          if (!existing) {
            await db
              .insert(ciRuns)
              .values({
                service_id: svc.id,
                github_run_id: job.run_id,
                run_attempt: runAttempt,
                head_sha: job.head_sha ?? '0'.repeat(40),
                status: 'in_progress',
                jobs: [jobItem],
                updated_at: new Date(),
              })
              .onConflictDoNothing();
          } else {
            const existingJobs = Array.isArray(existing.jobs) ? [...existing.jobs] : [];
            const idx = existingJobs.findIndex(
              (j) => j.id === jobItem.id || j.name === jobItem.name
            );
            if (idx >= 0) {
              existingJobs[idx] = jobItem;
            } else {
              existingJobs.push(jobItem);
            }
            await db
              .update(ciRuns)
              .set({
                jobs: existingJobs,
                updated_at: new Date(),
              })
              .where(eq(ciRuns.id, existing.id));
          }

          await markDelivery(deliveryId, 'processed');
          res.status(200).json({ ok: true, serviceId: svc.id, githubRunId: job.run_id });
          return;
        }

        await markDelivery(deliveryId, 'ignored');
        res.status(200).json({ ok: true, ignored: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markDelivery(deliveryId, 'failed', msg);
        res.status(500).json({
          error: { code: 'WEBHOOK_PROCESSING_FAILED', message: redactSecrets(msg) },
        });
      }
    }
  );

  return router;
}
