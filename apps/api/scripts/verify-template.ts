import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { renderTemplate } from '../src/templates/engine.js';

function runStep(
  label: string,
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv
): void {
  console.log(`\n==> ${label}`);
  try {
    execFileSync(cmd, args, {
      cwd,
      stdio: 'inherit',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    console.log(`PASS: ${label}`);
  } catch (err) {
    console.error(`FAIL: ${label}`);
    throw err;
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to allocate free port')));
      }
    });
  });
}

async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: res.status, body };
}

async function waitForReady(baseUrl: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchJson(`${baseUrl}/health/ready`);
      if (
        res.status === 200 &&
        typeof res.body === 'object' &&
        res.body !== null &&
        (res.body as { status?: string }).status === 'ready'
      ) {
        return;
      }
    } catch {
      // retry until deadline
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health/ready`);
}

function runPython312Checks(label: string, projectDir: string): void {
  const pyScript = [
    'set -euo pipefail',
    'python --version',
    'python -m venv /tmp/.venv',
    '/tmp/.venv/bin/pip install --quiet --no-cache-dir --retries 10 --timeout 120 --prefer-binary -c constraints.txt -r requirements.txt -r requirements-dev.txt',
    'echo "--- ruff check app tests ---"',
    '/tmp/.venv/bin/ruff check --cache-dir /tmp/.ruff_cache app tests',
    'echo "--- ruff format --check app tests ---"',
    '/tmp/.venv/bin/ruff format --check --cache-dir /tmp/.ruff_cache app tests',
    'echo "--- pytest ---"',
    '/tmp/.venv/bin/pytest -v -o cache_dir=/tmp/.pytest_cache',
  ].join(' && ');

  runStep(
    label,
    'docker',
    [
      'run',
      '--rm',
      '-e',
      'PYTHONDONTWRITEBYTECODE=1',
      '-v',
      `${projectDir}:/work:ro`,
      '-w',
      '/work',
      'python:3.12-slim',
      'bash',
      '-c',
      pyScript,
    ],
    projectDir
  );
}

function buildHostileDescription(): string {
  const base =
    'Hostile "desc" \'with\' `ticks`,\ttab, trailing   \n\n\n```python\nx=1;y = [1,2 ,3]\n```\n__SERVICE_NAME__ ';
  const padded = base.padEnd(300, 'x');
  if (padded.length !== 300) {
    throw new Error(`Expected hostile description length 300, got ${padded.length}`);
  }
  return padded;
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-verify-template-'));
  const hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-verify-hostile-'));
  const imageTag = 'forgeflow-smoke-service:verify';
  const composeProject = `forgeflow-smoke-${Date.now()}`;
  const composeImageTag = `${composeProject}-api`;
  let dockerBuilt = false;
  let composeStarted = false;

  try {
    console.log(`Rendering python-fastapi template (smoke-service) into ${tempDir}...`);
    const files = renderTemplate('python-fastapi', {
      serviceName: 'smoke-service',
      description: 'Smoke verification service for ForgeFlow FastAPI template.',
      templateVersion: '1.1.0',
    });

    if (files.length !== 21) {
      throw new Error(`Expected 21 rendered files, got ${files.length}`);
    }

    for (const file of files) {
      const targetPath = path.join(tempDir, file.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, file.content, 'utf8');
    }
    console.log(`PASS: Rendered ${files.length} files for smoke-service`);

    // 0. Run actionlint over the rendered .github/workflows/ci.yml
    runStep(
      'smoke-service: actionlint (.github/workflows/ci.yml with rhysd/actionlint:1.7.12)',
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${path.join(tempDir, '.github/workflows')}:/workflows:ro`,
        'rhysd/actionlint:1.7.12',
        '/workflows/ci.yml',
      ],
      tempDir
    );

    // 1. Run Python 3.12 lint, format, and unit tests inside python:3.12-slim container
    runPython312Checks(
      'smoke-service: Python 3.12 container checks (venv, pip -c constraints.txt, ruff check app tests, ruff format --check app tests, pytest)',
      tempDir
    );

    // 2. Hostile description test: render smoke-hostile with 300-char hostile Markdown/code description
    const hostileDescription = buildHostileDescription();
    console.log(
      `\nRendering python-fastapi template (smoke-hostile, ${hostileDescription.length}-char description) into ${hostileDir}...`
    );
    const hostileFiles = renderTemplate('python-fastapi', {
      serviceName: 'smoke-hostile',
      description: hostileDescription,
      templateVersion: '1.1.0',
    });

    for (const file of hostileFiles) {
      const targetPath = path.join(hostileDir, file.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, file.content, 'utf8');
    }
    console.log(`PASS: Rendered ${hostileFiles.length} files for smoke-hostile`);

    runPython312Checks(
      'smoke-hostile: Python 3.12 container checks (ruff check app tests, ruff format --check app tests, pytest)',
      hostileDir
    );

    // 3. Standalone Docker image build
    runStep('docker build', 'docker', ['build', '-t', imageTag, '.'], tempDir);
    dockerBuilt = true;

    // 4. Postgres + API Docker Compose smoke test (no postgres host port publication)
    const apiPort = await getFreePort();
    const pgPassword = crypto.randomBytes(16).toString('hex');

    const envContent = [
      'SERVICE_NAME=smoke-service',
      'POSTGRES_USER=postgres',
      `POSTGRES_PASSWORD=${pgPassword}`,
      'POSTGRES_DB=smoke_service',
      `API_PORT=${apiPort}`,
    ].join('\n');
    fs.writeFileSync(path.join(tempDir, '.env'), `${envContent}\n`, 'utf8');

    const composeEnv = { COMPOSE_PROJECT_NAME: composeProject };
    runStep(
      'docker compose up -d --build --wait',
      'docker',
      ['compose', 'up', '-d', '--build', '--wait'],
      tempDir,
      composeEnv
    );
    composeStarted = true;

    const baseUrl = `http://127.0.0.1:${apiPort}`;

    // GET /health
    const healthRes = await fetchJson(`${baseUrl}/health`);
    if (healthRes.status !== 200 || (healthRes.body as { status?: string })?.status !== 'ok') {
      console.error('FAIL: GET /health', healthRes);
      throw new Error(`Unexpected /health response: ${JSON.stringify(healthRes)}`);
    }
    console.log('PASS: GET /health ->', JSON.stringify(healthRes.body));

    // GET /health/ready
    const readyRes = await fetchJson(`${baseUrl}/health/ready`);
    if (readyRes.status !== 200 || (readyRes.body as { status?: string })?.status !== 'ready') {
      console.error('FAIL: GET /health/ready', readyRes);
      throw new Error(`Unexpected /health/ready response: ${JSON.stringify(readyRes)}`);
    }
    console.log('PASS: GET /health/ready ->', JSON.stringify(readyRes.body));

    // POST /items
    const createRes = await fetchJson(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Keyboard', quantity: 25 }),
    });
    if (createRes.status !== 201) {
      console.error('FAIL: POST /items', createRes);
      throw new Error(`Expected 201 from POST /items, got ${createRes.status}`);
    }
    console.log('PASS: POST /items -> 201', JSON.stringify(createRes.body));

    // GET /items
    const listBeforeRestart = await fetchJson(`${baseUrl}/items`);
    const itemsBefore = Array.isArray(listBeforeRestart.body) ? listBeforeRestart.body : [];
    const foundBefore = itemsBefore.some(
      (i: { name?: string; quantity?: number }) => i.name === 'Keyboard' && i.quantity === 25
    );
    if (listBeforeRestart.status !== 200 || !foundBefore) {
      console.error('FAIL: GET /items before restart', listBeforeRestart);
      throw new Error('Created item not found in GET /items');
    }
    console.log('PASS: GET /items before restart contains Keyboard (25)');

    // Restart API container and verify Postgres persistence
    runStep(
      'docker compose restart api',
      'docker',
      ['compose', 'restart', 'api'],
      tempDir,
      composeEnv
    );
    await waitForReady(baseUrl);

    const listAfterRestart = await fetchJson(`${baseUrl}/items`);
    const itemsAfter = Array.isArray(listAfterRestart.body) ? listAfterRestart.body : [];
    const foundAfter = itemsAfter.some(
      (i: { name?: string; quantity?: number }) => i.name === 'Keyboard' && i.quantity === 25
    );
    if (listAfterRestart.status !== 200 || !foundAfter) {
      console.error('FAIL: GET /items after restart', listAfterRestart);
      throw new Error('Item did not persist in Postgres after api restart');
    }
    console.log('PASS: GET /items after restart still contains Keyboard (25)');

    console.log('\nALL TEMPLATE VERIFICATION CHECKS PASSED');
  } finally {
    if (composeStarted) {
      try {
        execFileSync('docker', ['compose', 'down', '-v'], {
          cwd: tempDir,
          stdio: 'inherit',
          env: { ...process.env, COMPOSE_PROJECT_NAME: composeProject },
        });
      } catch {
        // ignore cleanup failure
      }
      try {
        execFileSync('docker', ['rmi', '-f', composeImageTag], { stdio: 'ignore' });
      } catch {
        // ignore cleanup failure
      }
    }
    if (dockerBuilt) {
      try {
        execFileSync('docker', ['rmi', '-f', imageTag], { stdio: 'ignore' });
      } catch {
        // ignore cleanup failure
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(hostileDir, { recursive: true, force: true });
    console.log(`Cleaned up ${tempDir} and ${hostileDir}`);
  }
}

main().catch((err) => {
  console.error('\nTEMPLATE VERIFICATION FAILED:', err);
  process.exit(1);
});
