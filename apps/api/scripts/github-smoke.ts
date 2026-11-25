import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const envPath = path.join(repoRoot, 'apps/api/.env');
dotenv.config({ path: envPath, override: true });
console.log(`Loaded env from ${envPath}`);

import { loadEnv, getGitHubConfig } from '../src/config/env.js';
import { RealGitHubClient } from '../src/github/client.js';

async function main(): Promise<void> {
  loadEnv();
  const cfg = getGitHubConfig();

  if (!cfg.configured || !cfg.config) {
    console.error(`GitHub App not configured: ${cfg.error ?? 'missing env vars'}`);
    process.exit(1);
  }

  const client = new RealGitHubClient(cfg.config);
  const repoName = `forgeflow-smoke-${Date.now()}`;
  let repoCreated = false;
  let cleanupSucceeded = false;

  try {
    console.log(`Creating private repository ${cfg.config.org}/${repoName}...`);
    const repo = await client.createRepository({
      name: repoName,
      description: 'Temporary ForgeFlow GitHub integration smoke test repository',
      private: true,
    });
    repoCreated = true;
    console.log(
      `Created: ${repo.fullName} (defaultBranch: ${repo.defaultBranch}, url: ${repo.url})`
    );

    const workflowYaml = [
      'name: Smoke',
      'on: [workflow_dispatch]',
      'jobs:',
      '  smoke:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "ForgeFlow GitHub smoke test"',
      '',
    ].join('\n');

    console.log('Committing .github/workflows/smoke.yml via createCommitWithFiles...');
    const commit = await client.createCommitWithFiles({
      repo: repo.name,
      branch: repo.defaultBranch,
      message: 'Add smoke workflow from ForgeFlow github:smoke',
      files: [
        {
          path: '.github/workflows/smoke.yml',
          content: workflowYaml,
        },
      ],
    });
    console.log(`Committed: ${commit.sha} (${commit.url})`);

    const head = await client.getHeadCommit(repo.name, repo.defaultBranch);
    if (head.sha !== commit.sha) {
      throw new Error(`Head SHA mismatch: expected ${commit.sha}, got ${head.sha}`);
    }
    console.log(`Verified branch head matches commit SHA: ${head.sha}`);
    console.log('\nPASS: GitHub App smoke test succeeded.');
  } finally {
    if (!repoCreated) {
      console.log('nothing to clean up');
    } else {
      try {
        console.log(`Cleaning up ${cfg.config.org}/${repoName}...`);
        await client.deleteRepository(repoName);
        cleanupSucceeded = true;
        console.log(`Cleanup succeeded: deleted ${cfg.config.org}/${repoName}`);
        try {
          await client.getRepository(repoName);
          console.error(`WARNING: ${cfg.config.org}/${repoName} still exists after delete!`);
        } catch (verifyErr) {
          const code = (verifyErr as { code?: string })?.code ?? 'UNKNOWN';
          console.log(`Verified deletion via getRepository('${repoName}'): ${code}`);
        }
      } catch (cleanupErr) {
        console.error(
          `Cleanup FAILED for ${cfg.config.org}/${repoName}:`,
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        );
      }
      console.log(`cleanupSucceeded=${cleanupSucceeded}`);
    }
  }
}

main().catch((err) => {
  console.error('github:smoke failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
