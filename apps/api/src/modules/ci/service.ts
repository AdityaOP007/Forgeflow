import { db } from '../../db/client.js';
import { ciRuns, services } from '../../db/schema.js';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { PUBLISH_JOB_NAME, type CiJobItem, type CiRunItem } from '@forgeflow/shared-types';
import type { GitHubClient, GitHubWorkflowJob, GitHubWorkflowRun } from '../../github/types.js';
import { redactSecrets } from '../../utils/redact.js';

export interface ParsedGitHubRepo {
  org: string;
  repo: string;
}

/**
 * Extracts GitHub org and repo name from a service's repository_url.
 * Returns null if the URL is missing, invalid, or belongs to a different org when expectedOrg is set.
 */
export function parseGitHubRepoUrl(
  repositoryUrl: string | null | undefined,
  expectedOrg?: string | null
): ParsedGitHubRepo | null {
  if (!repositoryUrl) return null;
  try {
    const parsed = new URL(repositoryUrl.trim());
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [org, repo] = parts;
    if (expectedOrg && org.toLowerCase() !== expectedOrg.toLowerCase()) {
      return null;
    }
    return { org, repo };
  } catch {
    return null;
  }
}

export function serializeCiRun(row: typeof ciRuns.$inferSelect): CiRunItem {
  const jobs = Array.isArray(row.jobs) ? row.jobs : [];
  const publishSucceeded = jobs.some(
    (j) => j.name === PUBLISH_JOB_NAME && j.conclusion === 'success'
  );

  return {
    id: row.id,
    serviceId: row.service_id,
    githubRunId: row.github_run_id,
    runAttempt: row.run_attempt,
    headSha: row.head_sha,
    headBranch: row.head_branch,
    event: row.event,
    status: row.status,
    conclusion: row.conclusion,
    htmlUrl: row.html_url,
    jobs,
    publishSucceeded,
    runStartedAt: row.run_started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapGitHubJob(job: GitHubWorkflowJob): CiJobItem {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    htmlUrl: job.htmlUrl,
  };
}

function computeRunCompletedAt(run: GitHubWorkflowRun, jobs: CiJobItem[]): Date | null {
  if (run.status !== 'completed') return null;
  const jobTimes = jobs
    .map((j) => (j.completedAt ? Date.parse(j.completedAt) : NaN))
    .filter((t) => !Number.isNaN(t));
  if (jobTimes.length > 0) {
    return new Date(Math.max(...jobTimes));
  }
  if (run.updatedAt) {
    const parsed = Date.parse(run.updatedAt);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return new Date();
}

async function ensureServiceExists(serviceId: string): Promise<typeof services.$inferSelect> {
  const [svc] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
  if (!svc) {
    const err = new Error('Service not found') as Error & { statusCode: number; code: string };
    err.statusCode = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return svc;
}

/** Lists stored CI runs for a service, newest first. */
export async function listServiceCiRuns(serviceId: string): Promise<CiRunItem[]> {
  await ensureServiceExists(serviceId);
  const rows = await db
    .select()
    .from(ciRuns)
    .where(eq(ciRuns.service_id, serviceId))
    .orderBy(sql`${ciRuns.run_started_at} DESC NULLS LAST`, desc(ciRuns.created_at))
    .limit(50);

  return rows.map(serializeCiRun);
}

/**
 * Fetches GitHub Actions workflow runs and jobs for a service's repository
 * and upserts them into ci_runs.
 */
export async function syncServiceCiRuns(
  serviceId: string,
  client: GitHubClient,
  expectedOrg?: string | null
): Promise<{ runs: CiRunItem[]; synced: number }> {
  const svc = await ensureServiceExists(serviceId);
  const parsed = parseGitHubRepoUrl(svc.repository_url, expectedOrg);
  if (!parsed) {
    return { runs: await listServiceCiRuns(serviceId), synced: 0 };
  }

  const remoteRuns = await client.listWorkflowRuns(parsed.repo, { perPage: 20 });

  // Check which runs are already completed with jobs so we skip redundant job API calls
  const existingRows = await db.select().from(ciRuns).where(eq(ciRuns.service_id, serviceId));
  const existingByKey = new Map<string, typeof ciRuns.$inferSelect>();
  for (const r of existingRows) {
    existingByKey.set(`${r.github_run_id}:${r.run_attempt}`, r);
  }

  let synced = 0;
  for (const run of remoteRuns) {
    const key = `${run.id}:${run.runAttempt}`;
    const existing = existingByKey.get(key);
    const alreadyComplete =
      existing &&
      existing.status === 'completed' &&
      existing.conclusion === run.conclusion &&
      Array.isArray(existing.jobs) &&
      existing.jobs.length > 0;

    if (alreadyComplete) {
      continue;
    }

    const remoteJobs = await client.listWorkflowJobs(parsed.repo, run.id, run.runAttempt);
    const mappedJobs = remoteJobs.map(mapGitHubJob);
    const runStartedAt = run.runStartedAt ? new Date(run.runStartedAt) : null;
    const completedAt = computeRunCompletedAt(run, mappedJobs);

    await db
      .insert(ciRuns)
      .values({
        service_id: serviceId,
        github_run_id: run.id,
        run_attempt: run.runAttempt,
        head_sha: run.headSha,
        head_branch: run.headBranch,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        html_url: run.htmlUrl,
        jobs: mappedJobs,
        run_started_at: runStartedAt,
        completed_at: completedAt,
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: [ciRuns.service_id, ciRuns.github_run_id, ciRuns.run_attempt],
        set: {
          head_sha: run.headSha,
          head_branch: run.headBranch,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.htmlUrl,
          jobs: mappedJobs,
          run_started_at: runStartedAt,
          completed_at: completedAt,
          updated_at: new Date(),
        },
      });

    synced++;
  }

  const runs = await listServiceCiRuns(serviceId);
  return { runs, synced };
}

/**
 * Syncs CI runs for all ready services that have a GitHub repository URL.
 * Used by the worker's periodic background sync loop.
 */
export async function syncAllServicesCiRuns(
  client: GitHubClient,
  expectedOrg?: string | null
): Promise<{ servicesChecked: number; runsSynced: number; errors: number }> {
  const readyServices = await db
    .select()
    .from(services)
    .where(and(eq(services.provisioning_status, 'ready'), isNotNull(services.repository_url)));

  let servicesChecked = 0;
  let runsSynced = 0;
  let errors = 0;

  for (const svc of readyServices) {
    const parsed = parseGitHubRepoUrl(svc.repository_url, expectedOrg);
    if (!parsed) continue;
    servicesChecked++;
    try {
      const res = await syncServiceCiRuns(svc.id, client, expectedOrg);
      runsSynced += res.synced;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CI Sync] Failed to sync ${svc.name} (${svc.id}): ${redactSecrets(msg)}`);
    }
  }

  return { servicesChecked, runsSynced, errors };
}
