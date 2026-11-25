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

const REQUIRED_PERMISSIONS: Array<{ key: string; expected: 'write' | 'read' }> = [
  { key: 'administration', expected: 'write' },
  { key: 'contents', expected: 'write' },
  { key: 'workflows', expected: 'write' },
  { key: 'metadata', expected: 'read' },
];

async function main(): Promise<void> {
  loadEnv();
  const cfg = getGitHubConfig();

  console.log(`configured: ${cfg.configured}`);
  if (!cfg.configured || !cfg.config) {
    console.error(`error: ${cfg.error ?? 'Not configured'}`);
    process.exit(1);
  }

  console.log(`org: ${cfg.config.org}`);

  const client = new RealGitHubClient(cfg.config);
  const info = await client.getInstallationInfo();

  console.log(`installationId: ${info.installationId}`);
  console.log(`accountLogin: ${info.accountLogin}`);
  console.log(`repositorySelection: ${info.repositorySelection}`);
  console.log('permissions:');

  let hasFailure = false;

  if (info.accountLogin.toLowerCase() !== cfg.config.org.toLowerCase()) {
    console.error(
      `FAIL: installation account '${info.accountLogin}' does not match GITHUB_ORG '${cfg.config.org}'`
    );
    hasFailure = true;
  }

  if (info.repositorySelection !== 'all') {
    console.error(`FAIL: repositorySelection is '${info.repositorySelection}', expected 'all'`);
    hasFailure = true;
  }

  for (const req of REQUIRED_PERMISSIONS) {
    const level = info.permissions[req.key];
    const ok = req.expected === 'read' ? level === 'read' || level === 'write' : level === 'write';
    console.log(
      `  - ${req.key}: ${ok ? `present (${level})` : `MISSING (got: ${level ?? 'none'})`}`
    );
    if (!ok) {
      hasFailure = true;
    }
  }

  if (hasFailure) {
    process.exit(1);
  }

  console.log('\nPASS: GitHub App configuration and permissions verified.');
}

main().catch((err) => {
  console.error('github:check failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
