import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const WORKER_KUBECONFIG = path.resolve(
  REPO_ROOT,
  process.env.KUBECONFIG_WORKER_PATH || 'secrets/worker-kubeconfig.yaml'
);

if (!fs.existsSync(WORKER_KUBECONFIG)) {
  console.error(`Worker kubeconfig not found at ${WORKER_KUBECONFIG}. Run pnpm k8s:up first.`);
  process.exit(1);
}

const CHECKS = [
  // ALLOWED in forgeflow-dev
  ...['deployments', 'statefulsets', 'services', 'persistentvolumeclaims'].flatMap((resource) =>
    ['create', 'get', 'list', 'watch', 'delete'].map((verb) => ({
      verb,
      resource,
      namespace: 'forgeflow-dev',
      expected: 'yes',
    }))
  ),
  ...['secrets'].flatMap((resource) =>
    ['create', 'get', 'list', 'delete'].map((verb) => ({
      verb,
      resource,
      namespace: 'forgeflow-dev',
      expected: 'yes',
    }))
  ),
  ...['pods'].flatMap((resource) =>
    ['get', 'list', 'watch'].map((verb) => ({
      verb,
      resource,
      namespace: 'forgeflow-dev',
      expected: 'yes',
    }))
  ),
  ...['events'].flatMap((resource) =>
    ['get', 'list'].map((verb) => ({
      verb,
      resource,
      namespace: 'forgeflow-dev',
      expected: 'yes',
    }))
  ),
  // DENIED cluster-wide / other namespaces
  { verb: 'get', resource: 'nodes', namespace: null, expected: 'no' },
  { verb: 'create', resource: 'namespaces', namespace: null, expected: 'no' },
  { verb: 'list', resource: 'secrets', namespace: 'kube-system', expected: 'no' },
  { verb: 'list', resource: 'pods', namespace: 'default', expected: 'no' },
  { verb: 'create', resource: 'clusterroles', namespace: null, expected: 'no' },
  { verb: 'create', resource: 'clusterrolebindings', namespace: null, expected: 'no' },
  { verb: 'delete', resource: 'namespaces', namespace: null, expected: 'no' },
];

function canI(verb, resource, namespace) {
  const args = ['--kubeconfig', WORKER_KUBECONFIG, 'auth', 'can-i', verb, resource];
  if (namespace) {
    args.push('--namespace', namespace);
  }
  try {
    const out = execFileSync('kubectl', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out === 'yes' ? 'yes' : 'no';
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout).trim() : '';
    if (stdout === 'no') return 'no';
    throw err;
  }
}

let failures = 0;
console.log('VERB     | RESOURCE                 | NAMESPACE     | EXPECTED | ACTUAL | RESULT');
console.log('---------+--------------------------+---------------+----------+--------+-------');

for (const c of CHECKS) {
  const actual = canI(c.verb, c.resource, c.namespace);
  const ok = actual === c.expected;
  if (!ok) failures++;
  console.log(
    `${c.verb.padEnd(8)} | ${c.resource.padEnd(24)} | ${(c.namespace ?? '(cluster)').padEnd(13)} | ${c.expected.padEnd(8)} | ${actual.padEnd(6)} | ${ok ? 'PASS' : 'FAIL'}`
  );
}

if (failures > 0) {
  console.error(`\nRBAC verification FAILED (${failures} mismatched check(s)).`);
  process.exit(1);
}

console.log(`\nRBAC verification PASSED (${CHECKS.length} checks).`);
