import { db } from '../../db/client.js';
import { ciRuns, services } from '../../db/schema.js';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  PUBLISH_JOB_NAME,
  type CiJobItem,
  type CiRunItem,
  type DeployableCommitItem,
} from '@forgeflow/shared-types';
import {
  GitHubError,
  type GitHubClient,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
} from '../../github/types.js';
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

export interface NormalizedCiRun {
  githubRunId: number;
  runAttempt: number;
  headSha: string;
  headBranch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  jobs: CiJobItem[];
  publishSucceeded: boolean;
  runStartedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

/**
 * Pure normalization function turning raw GitHub Actions workflow run + jobs
 * into the normalized database/domain shape.
 */
export function normalizeRun(run: GitHubWorkflowRun, jobs: GitHubWorkflowJob[]): NormalizedCiRun {
  const mappedJobs = jobs.map(mapGitHubJob);
  const runStartedAt = run.runStartedAt ? new Date(run.runStartedAt) : null;
  const completedAt = computeRunCompletedAt(run, mappedJobs);
  const updatedAt = run.updatedAt ? new Date(run.updatedAt) : new Date();
  const publishSucceeded = mappedJobs.some(
    (j) => j.name === PUBLISH_JOB_NAME && j.conclusion === 'success'
  );

  return {
    githubRunId: run.id,
    runAttempt: run.runAttempt || 1,
    headSha: run.headSha.toLowerCase(),
    headBranch: run.headBranch ?? null,
    event: run.event || 'push',
    status: run.status || 'queued',
    conclusion: run.conclusion ?? null,
    htmlUrl: run.htmlUrl,
    jobs: mappedJobs,
    publishSucceeded,
    runStartedAt: runStartedAt && !Number.isNaN(runStartedAt.getTime()) ? runStartedAt : null,
    completedAt: completedAt && !Number.isNaN(completedAt.getTime()) ? completedAt : null,
    updatedAt: !Number.isNaN(updatedAt.getTime()) ? updatedAt : new Date(),
  };
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
 * Lists deployable commits for a service:
 * commits on the default branch ('main') whose completed CI run concluded 'success'
 * AND whose jobs include PUBLISH_JOB_NAME with conclusion 'success', newest first.
 */
export async function listDeployableCommits(
  serviceId: string,
  defaultBranch = 'main'
): Promise<DeployableCommitItem[]> {
  await ensureServiceExists(serviceId);
  const rows = await db
    .select()
    .from(ciRuns)
    .where(
      and(
        eq(ciRuns.service_id, serviceId),
        eq(ciRuns.head_branch, defaultBranch),
        eq(ciRuns.status, 'completed'),
        eq(ciRuns.conclusion, 'success')
      )
    )
    .orderBy(
      sql`${ciRuns.completed_at} DESC NULLS LAST`,
      sql`${ciRuns.run_started_at} DESC NULLS LAST`,
      desc(ciRuns.created_at)
    );

  const seenShas = new Set<string>();
  const result: DeployableCommitItem[] = [];

  for (const row of rows) {
    if (seenShas.has(row.head_sha)) continue;
    const jobs = Array.isArray(row.jobs) ? row.jobs : [];
    const hasPublished = jobs.some(
      (j) => j.name === PUBLISH_JOB_NAME && j.conclusion === 'success'
    );
    if (!hasPublished) continue;

    seenShas.add(row.head_sha);
    result.push({
      commitSha: row.head_sha,
      shortSha: row.head_sha.slice(0, 7),
      ciRunId: row.id,
      htmlUrl: row.html_url,
      completedAt: (row.completed_at ?? row.updated_at).toISOString(),
    });
  }

  return result;
}

/**
 * Fetches the latest 10 workflow runs on the default branch for a service's repository
 * and upserts them into ci_runs. Fetches jobs only for runs in progress or newly completed.
 */
export async function syncServiceCiRuns(
  serviceId: string,
  client: GitHubClient,
  expectedOrg?: string | null,
  defaultBranch = 'main'
): Promise<{ runs: CiRunItem[]; synced: number }> {
  const svc = await ensureServiceExists(serviceId);
  const parsed = parseGitHubRepoUrl(svc.repository_url, expectedOrg);
  if (!parsed) {
    return { runs: await listServiceCiRuns(serviceId), synced: 0 };
  }

  const remoteRuns = await client.listWorkflowRuns(parsed.repo, {
    branch: defaultBranch,
    perPage: 10,
  });

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

    // Fetch jobs only for runs in progress or newly completed
    const remoteJobs = await client.listWorkflowJobs(parsed.repo, run.id, run.runAttempt);
    const normalized = normalizeRun(run, remoteJobs);

    // Older-updated_at-never-overwrites-newer guard
    if (existing && existing.updated_at > normalized.updatedAt) {
      continue;
    }

    await db
      .insert(ciRuns)
      .values({
        service_id: serviceId,
        github_run_id: normalized.githubRunId,
        run_attempt: normalized.runAttempt,
        head_sha: normalized.headSha,
        head_branch: normalized.headBranch,
        event: normalized.event,
        status: normalized.status,
        conclusion: normalized.conclusion,
        html_url: normalized.htmlUrl,
        jobs: normalized.jobs,
        run_started_at: normalized.runStartedAt,
        completed_at: normalized.completedAt,
        updated_at: normalized.updatedAt,
      })
      .onConflictDoUpdate({
        target: [ciRuns.service_id, ciRuns.github_run_id, ciRuns.run_attempt],
        set: {
          head_sha: normalized.headSha,
          head_branch: normalized.headBranch,
          event: normalized.event,
          status: normalized.status,
          conclusion: normalized.conclusion,
          html_url: normalized.htmlUrl,
          jobs: normalized.jobs,
          run_started_at: normalized.runStartedAt,
          completed_at: normalized.completedAt,
          updated_at: normalized.updatedAt,
        },
        where: sql`${ciRuns.updated_at} <= ${normalized.updatedAt}`,
      });

    synced++;
  }

  const runs = await listServiceCiRuns(serviceId);
  return { runs, synced };
}

/**
 * Syncs CI runs for all ready services that have a GitHub repository URL.
 * Isolates failures per service and backs off immediately if RATE_LIMITED.
 */
export async function syncAllServicesCiRuns(
  client: GitHubClient,
  expectedOrg?: string | null
): Promise<{
  servicesChecked: number;
  runsSynced: number;
  errors: number;
  rateLimited: boolean;
}> {
  const readyServices = await db
    .select()
    .from(services)
    .where(and(eq(services.provisioning_status, 'ready'), isNotNull(services.repository_url)));

  let servicesChecked = 0;
  let runsSynced = 0;
  let errors = 0;
  let rateLimited = false;

  for (const svc of readyServices) {
    const parsed = parseGitHubRepoUrl(svc.repository_url, expectedOrg);
    if (!parsed) continue;
    servicesChecked++;
    try {
      const res = await syncServiceCiRuns(svc.id, client, expectedOrg);
      runsSynced += res.synced;
    } catch (err) {
      errors++;
      if (err instanceof GitHubError && err.code === 'RATE_LIMITED') {
        rateLimited = true;
        console.warn(
          `[CI Sync] GitHub rate limit hit while syncing ${svc.name}; backing off remaining services.`
        );
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CI Sync] Failed to sync ${svc.name} (${svc.id}): ${redactSecrets(msg)}`);
    }
  }

  return { servicesChecked, runsSynced, errors, rateLimited };
}

/** Returns true if any CI run is currently queued or in_progress. */
export async function hasInProgressCiRuns(): Promise<boolean> {
  const rows = await db
    .select({ id: ciRuns.id })
    .from(ciRuns)
    .where(inArray(ciRuns.status, ['queued', 'in_progress']))
    .limit(1);
  return rows.length > 0;
}
