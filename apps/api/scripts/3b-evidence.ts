/**
 * 3B evidence script: file list, commit SHA, CI jobs for shop-service.
 * Run with: cd apps/api && node_modules/.bin/tsx scripts/3b-evidence.ts
 * Never prints tokens or .env contents.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const envPath = path.join(repoRoot, 'apps/api/.env');
dotenv.config({ path: envPath, override: true });

import { loadEnv, getGitHubConfig } from '../src/config/env.js';
import { db } from '../src/db/client.js';
import { services, workflowRuns } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { RealGitHubClient } from '../src/github/client.js';

const SERVICE_NAME = 'shop-service';
const EXPECTED_SHA = '5792579ff7dfb1ade2a0351211f9dbbdb03033e8';

async function main() {
  loadEnv();
  const cfg = getGitHubConfig();
  if (!cfg.configured || !cfg.config) {
    console.error(`GitHub App not configured: ${cfg.error ?? 'missing env vars'}`);
    process.exit(1);
  }
  const ORG = cfg.config.org;

  // ── 1. Database ───────────────────────────────────────────────────────────
  const [svc] = await db.select().from(services).where(eq(services.name, SERVICE_NAME));

  if (!svc) {
    console.error(`Service "${SERVICE_NAME}" not found in database.`);
    process.exit(1);
  }
  console.log(`\nService: ${svc.name}  id=${svc.id}  status=${svc.provisioning_status}`);

  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.service_id, svc.id));
  const scaffoldRun = runs
    .filter((r) => r.type === 'scaffold')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  if (!scaffoldRun) {
    console.error('No scaffold workflow run found.');
    process.exit(1);
  }

  type Resources = { commit?: { sha?: string } };
  const resources = scaffoldRun.resources as Resources | null;
  const commitSha = resources?.commit?.sha ?? '(not in resources)';

  console.log(`Scaffold run: id=${scaffoldRun.id}  status=${scaffoldRun.status}`);
  console.log(`resources.commit.sha = ${commitSha}`);
  console.log(`Expected image tag   = ${EXPECTED_SHA}`);
  console.log(`SHA matches image tag? ${commitSha === EXPECTED_SHA ? 'YES ✅' : 'NO ❌'}`);

  // ── 2. GitHub: file list ──────────────────────────────────────────────────
  const github = new RealGitHubClient(cfg.config);

  console.log(`\n── File list for ${ORG}/${SERVICE_NAME} (commit ${commitSha.slice(0, 7)}) ──`);
  const tree = await github.getRepositoryTree(ORG, SERVICE_NAME, commitSha);
  const files = tree
    .filter((e) => e.type === 'blob')
    .map((e) => e.path)
    .sort();

  for (const f of files) {
    console.log(`  ${f}`);
  }
  console.log(`\nTotal files: ${files.length} (expected 21)`);
  const tmplFiles = files.filter((f) => f.endsWith('.tmpl'));
  console.log(`Files ending in .tmpl: ${tmplFiles.length} (expected 0)`);

  // ── 3. GitHub: CI check runs for the commit ───────────────────────────────
  console.log(`\n── CI check runs for ${ORG}/${SERVICE_NAME}@${commitSha.slice(0, 7)} ──`);
  const checkRuns = await github.listCheckRunsForCommit(ORG, SERVICE_NAME, commitSha);
  if (checkRuns.length === 0) {
    console.log('  (no check runs found)');
  }
  for (const job of checkRuns) {
    console.log(`  job: "${job.name}"  status=${job.status}  conclusion=${job.conclusion}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
