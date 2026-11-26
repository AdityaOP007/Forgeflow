import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderTemplate } from '../../apps/api/src/templates/engine.js';
import { getHelmRollbackFlag, RealK8sRunner } from '../../apps/api/src/k8s/exec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const CHART_PATH = path.join(REPO_ROOT, 'infrastructure/helm/service-chart');

const RELEASE = 'chart-smoke';
const IMAGE_REPO = 'forgeflow-local/chart-smoke';
const IMAGE_TAG = '0000000000000000000000000000000000000001';
const NODE_PORT = 30080;
const DB_SECRET_NAME = `${RELEASE}-db`;

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitForReady(baseUrl: string, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ready = await fetchJson(`${baseUrl}/health/ready`);
      if (ready.status === 200 && ready.body?.status === 'ready') {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health/ready`);
}

async function main() {
  const runner = new RealK8sRunner();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-k8s-smoke-'));
  const dbPassword = crypto.randomBytes(24).toString('hex');
  const dbUrl = `postgresql+psycopg://postgres:${dbPassword}@${RELEASE}-postgres:5432/chart_smoke`;

  try {
    console.log('1. Rendering fastapi-service template as chart-smoke...');
    const files = renderTemplate('python-fastapi', {
      serviceName: RELEASE,
      description: 'Kubernetes Helm chart smoke test service',
      templateVersion: '1.0.0',
    });
    for (const f of files) {
      const dest = path.join(tmpDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let content = f.content;
      // Ensure numeric UID 10001 for runAsNonRoot verification on 1.0.0 Dockerfile
      if (f.path === 'Dockerfile') {
        content = content
          .replace(
            /adduser\s+--system\s+--ingroup\s+appgroup\s+appuser/,
            'adduser --system --uid 10001 --ingroup appgroup appuser'
          )
          .replace(/USER\s+appuser/, 'USER 10001');
      }
      fs.writeFileSync(dest, content, 'utf8');
    }

    console.log(`2. Building Docker image ${IMAGE_REPO}:${IMAGE_TAG}...`);
    execFileSync('docker', ['build', '-t', `${IMAGE_REPO}:${IMAGE_TAG}`, tmpDir], {
      stdio: 'inherit',
    });

    console.log('3. Loading image into kind cluster forgeflow...');
    execFileSync(
      'kind',
      ['load', 'docker-image', `${IMAGE_REPO}:${IMAGE_TAG}`, '--name', 'forgeflow'],
      {
        stdio: 'inherit',
      }
    );

    console.log('4. Creating DB secret via K8sRunner (stdin)...');
    const secretManifest = JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: DB_SECRET_NAME,
        labels: {
          'app.kubernetes.io/instance': RELEASE,
          'app.kubernetes.io/managed-by': 'forgeflow',
        },
      },
      type: 'Opaque',
      stringData: {
        POSTGRES_PASSWORD: dbPassword,
        DATABASE_URL: dbUrl,
      },
    });
    await runner.kubectl(['apply', '-f', '-'], { stdin: secretManifest });

    const rollbackFlag = await getHelmRollbackFlag(runner);
    console.log(`5. Installing Helm chart with ${rollbackFlag} --wait...`);
    await runner.helm([
      'upgrade',
      '--install',
      RELEASE,
      CHART_PATH,
      rollbackFlag,
      '--wait',
      '--timeout',
      '180s',
      '--set',
      `name=${RELEASE}`,
      '--set',
      `image.repository=${IMAGE_REPO}`,
      '--set',
      `image.tag=${IMAGE_TAG}`,
      '--set',
      'image.pullPolicy=IfNotPresent',
      '--set',
      `nodePort=${NODE_PORT}`,
      '--set',
      `database.existingSecret=${DB_SECRET_NAME}`,
    ]);

    const baseUrl = `http://127.0.0.1:${NODE_PORT}`;
    console.log(`6. Verifying ${baseUrl}/health and /health/ready...`);
    const health = await fetchJson(`${baseUrl}/health`);
    if (health.status !== 200 || health.body?.status !== 'ok') {
      throw new Error(`Unexpected /health response: ${JSON.stringify(health)}`);
    }
    const ready = await fetchJson(`${baseUrl}/health/ready`);
    if (ready.status !== 200 || ready.body?.status !== 'ready') {
      throw new Error(`Unexpected /health/ready response: ${JSON.stringify(ready)}`);
    }

    console.log('7. Creating item via POST /items...');
    const created = await fetchJson(`${baseUrl}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'K8sSmokeItem', quantity: 7 }),
    });
    if (created.status !== 201) {
      throw new Error(`POST /items failed: ${JSON.stringify(created)}`);
    }

    console.log(
      '8. Deleting app pod and postgres pod (admin context) to verify PVC persistence...'
    );
    execFileSync(
      'kubectl',
      [
        '--context',
        'kind-forgeflow',
        '-n',
        'forgeflow-dev',
        'delete',
        'pod',
        '-l',
        `app.kubernetes.io/instance=${RELEASE}`,
      ],
      { stdio: 'inherit' }
    );
    await waitForReady(baseUrl, 120000);

    const items = await fetchJson(`${baseUrl}/items`);
    const found =
      Array.isArray(items.body) &&
      items.body.some((x: { name?: string }) => x.name === 'K8sSmokeItem');
    if (!found) {
      throw new Error(`Item did not persist after pod restart: ${JSON.stringify(items)}`);
    }
    console.log('PASS: Item persisted across app + postgres pod deletion.');
  } finally {
    console.log('9. Cleaning up Helm release, PVC, and DB secret...');
    try {
      await runner.helm(['uninstall', RELEASE]);
    } catch {
      // ignore if not installed
    }
    try {
      await runner.kubectl([
        'delete',
        'pvc',
        '-l',
        `app.kubernetes.io/instance=${RELEASE}`,
        '--ignore-not-found',
      ]);
    } catch {
      // ignore
    }
    try {
      await runner.kubectl(['delete', 'secret', DB_SECRET_NAME, '--ignore-not-found']);
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  let remainingOut = '';
  for (let i = 0; i < 30; i++) {
    const remaining = await runner.kubectl([
      'get',
      'deployments,statefulsets,replicasets,pods,services,secrets,configmaps,persistentvolumeclaims',
      '-l',
      `app.kubernetes.io/instance=${RELEASE}`,
      '-o',
      'name',
    ]);
    remainingOut = remaining.stdout.trim();
    if (remainingOut === '') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (remainingOut !== '') {
    throw new Error(`Cleanup incomplete, remaining resources: ${remainingOut}`);
  }
  console.log('PASS: Cleanup verified — no resources labeled with chart-smoke remain.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
