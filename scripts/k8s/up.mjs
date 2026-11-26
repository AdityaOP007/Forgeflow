import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const KIND_CONFIG = path.join(REPO_ROOT, 'infrastructure/kubernetes/kind-config.yaml');
const RBAC_MANIFEST = path.join(REPO_ROOT, 'infrastructure/kubernetes/rbac.yaml');
const WORKER_KUBECONFIG = path.join(REPO_ROOT, 'secrets/worker-kubeconfig.yaml');

const CLUSTER_NAME = 'forgeflow';
const CONTEXT = `kind-${CLUSTER_NAME}`;
const NAMESPACE = 'forgeflow-dev';

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

async function waitForWorkerSecret() {
  for (let i = 0; i < 30; i++) {
    try {
      const json = run('kubectl', [
        '--context',
        CONTEXT,
        '-n',
        NAMESPACE,
        'get',
        'secret',
        'forgeflow-worker-token',
        '-o',
        'json',
      ]);
      const parsed = JSON.parse(json);
      const tokenB64 = parsed?.data?.token;
      const caB64 = parsed?.data?.['ca.crt'];
      if (tokenB64 && caB64) {
        return {
          token: Buffer.from(tokenB64, 'base64').toString('utf8'),
          caB64,
        };
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Timed out waiting for forgeflow-worker-token secret data');
}

async function main() {
  console.log('Checking existing kind clusters...');
  const clustersRaw = run('kind', ['get', 'clusters']);
  const clusters = clustersRaw ? clustersRaw.split(/\r?\n/).map((s) => s.trim()) : [];

  if (!clusters.includes(CLUSTER_NAME)) {
    console.log(`Creating kind cluster '${CLUSTER_NAME}'...`);
    execFileSync('kind', ['create', 'cluster', '--config', KIND_CONFIG], {
      stdio: 'inherit',
    });
  } else {
    console.log(`Kind cluster '${CLUSTER_NAME}' already exists.`);
  }

  console.log('Applying namespace and restricted worker RBAC...');
  execFileSync('kubectl', ['--context', CONTEXT, 'apply', '-f', RBAC_MANIFEST], {
    stdio: 'inherit',
  });

  console.log('Waiting for forgeflow-worker-token secret...');
  const { token, caB64 } = await waitForWorkerSecret();

  const server = run('kubectl', [
    '--context',
    CONTEXT,
    'config',
    'view',
    '--minify',
    '-o',
    'jsonpath={.clusters[0].cluster.server}',
  ]);
  if (!server) {
    throw new Error('Could not determine cluster API server URL from context');
  }

  fs.mkdirSync(path.dirname(WORKER_KUBECONFIG), { recursive: true });
  const kubeconfigYaml = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '  - name: forgeflow',
    '    cluster:',
    `      certificate-authority-data: ${caB64}`,
    `      server: ${server}`,
    'contexts:',
    '  - name: forgeflow-worker',
    '    context:',
    '      cluster: forgeflow',
    `      namespace: ${NAMESPACE}`,
    '      user: forgeflow-worker',
    'current-context: forgeflow-worker',
    'users:',
    '  - name: forgeflow-worker',
    '    user:',
    `      token: ${token}`,
    '',
  ].join('\n');

  fs.writeFileSync(WORKER_KUBECONFIG, kubeconfigYaml, { mode: 0o600 });
  fs.chmodSync(WORKER_KUBECONFIG, 0o600);
  console.log(
    `Wrote restricted worker kubeconfig to ${path.relative(REPO_ROOT, WORKER_KUBECONFIG)} (mode 0600).`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
