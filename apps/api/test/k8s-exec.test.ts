import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getHelmRollbackFlag,
  K8sArgValidationError,
  K8sCommandError,
  RealK8sRunner,
  validateHelmArgs,
  validateKubectlArgs,
} from '../src/k8s/exec.js';
import { FakeK8sRunner } from './fakes/fake-k8s-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(__dirname, '../src');

describe('K8sRunner argument validation & privilege boundary — Checkpoint 3A', () => {
  it('allows valid kubectl verbs and apply -f -', () => {
    expect(() => validateKubectlArgs(['get', 'pods'])).not.toThrow();
    expect(() => validateKubectlArgs(['apply', '-f', '-'])).not.toThrow();
    expect(() => validateKubectlArgs(['delete', 'pvc', '-l', 'app=test'])).not.toThrow();
    expect(() => validateKubectlArgs(['rollout', 'status', 'deployment/app'])).not.toThrow();
    expect(() => validateKubectlArgs(['auth', 'can-i', 'get', 'pods'])).not.toThrow();
    expect(() => validateKubectlArgs(['version', '--client'])).not.toThrow();
  });

  it('allows valid helm subcommands', () => {
    for (const sub of [
      'upgrade',
      'uninstall',
      'status',
      'history',
      'get',
      'list',
      'lint',
      'template',
    ]) {
      expect(() => validateHelmArgs([sub, 'my-release'])).not.toThrow();
    }
  });

  it('rejects disallowed kubectl verbs and helm subcommands', () => {
    expect(() => validateKubectlArgs(['exec', 'pod/foo', '--', 'sh'])).toThrow(
      K8sArgValidationError
    );
    expect(() => validateKubectlArgs(['port-forward', 'pod/foo', '8080:80'])).toThrow(
      K8sArgValidationError
    );
    expect(() => validateKubectlArgs(['create', 'namespace', 'evil'])).toThrow(
      K8sArgValidationError
    );
    expect(() => validateHelmArgs(['repo', 'add', 'evil', 'https://example.com'])).toThrow(
      K8sArgValidationError
    );
    expect(() => validateHelmArgs(['plugin', 'install', 'foo'])).toThrow(K8sArgValidationError);
  });

  it('rejects kubectl apply without -f -', () => {
    expect(() => validateKubectlArgs(['apply', '-f', '/tmp/secret.yaml'])).toThrow(
      "kubectl apply must use '-f -'"
    );
    expect(() => validateKubectlArgs(['apply'])).toThrow("kubectl apply must use '-f -'");
  });

  it('rejects forbidden flags (--kubeconfig, --context, --namespace, -n, --all-namespaces, -A, --token, --server)', () => {
    const forbidden = [
      ['get', 'pods', '--kubeconfig', '/etc/passwd'],
      ['get', 'pods', '--kubeconfig=/etc/passwd'],
      ['get', 'pods', '--context', 'admin'],
      ['get', 'pods', '--namespace', 'kube-system'],
      ['get', 'pods', '-n', 'kube-system'],
      ['get', 'pods', '-n=default'],
      ['get', 'pods', '--all-namespaces'],
      ['get', 'pods', '-A'],
      ['get', 'pods', '--token', 'secret-token'],
      ['get', 'pods', '--server', 'https://evil:6443'],
    ];

    for (const args of forbidden) {
      expect(() => validateKubectlArgs(args)).toThrow(K8sArgValidationError);
      expect(() => validateHelmArgs(['status', 'rel', ...args.slice(2)])).toThrow(
        K8sArgValidationError
      );
    }
  });

  it('rejects arguments containing newline, CR, or NUL bytes', () => {
    expect(() => validateKubectlArgs(['get', 'pods\n--all-namespaces'])).toThrow(
      K8sArgValidationError
    );
    expect(() => validateKubectlArgs(['get', 'pods\rfoo'])).toThrow(K8sArgValidationError);
    expect(() => validateHelmArgs(['status', 'rel\0evil'])).toThrow(K8sArgValidationError);
  });

  it('redacts secrets in K8sCommandError', () => {
    const err = new K8sCommandError(
      'Failed with token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def and ghp_0123456789abcdefghijklmnopqrstuvwxyz0123',
      1,
      'certificate-authority-data: LS0tLS1CRUdJTi...',
      'password=supersecret'
    );
    expect(err.message).not.toContain('eyJhbGci');
    expect(err.message).not.toContain('ghp_0123456789');
    expect(err.stdout).not.toContain('LS0tLS1CRUdJTi');
    expect(err.stderr).not.toContain('supersecret');
  });

  it('FakeK8sRunner records allowlisted calls and rejects invalid calls', async () => {
    const fake = new FakeK8sRunner();
    fake.onKubectl(() => ({ stdout: '{"items":[]}', stderr: '' }));
    const res = await fake.kubectl(['get', 'pods']);
    expect(res.stdout).toBe('{"items":[]}');
    expect(fake.calls).toHaveLength(1);
    await expect(fake.kubectl(['exec', 'pod/a'])).rejects.toThrow(K8sArgValidationError);
  });

  it('selects --atomic for Helm 3 and --rollback-on-failure for Helm 4 (cached per runner)', async () => {
    const helm3Runner = new FakeK8sRunner();
    helm3Runner.onHelm(() => ({ stdout: 'v3.16.4+g7c6d54d\n', stderr: '' }));
    expect(await getHelmRollbackFlag(helm3Runner)).toBe('--atomic');
    // Cached on second call
    expect(await getHelmRollbackFlag(helm3Runner)).toBe('--atomic');
    expect(helm3Runner.calls).toHaveLength(1);

    const helm4Runner = new FakeK8sRunner();
    helm4Runner.onHelm(() => ({ stdout: 'v4.0.0+g1234567\n', stderr: '' }));
    expect(await getHelmRollbackFlag(helm4Runner)).toBe('--rollback-on-failure');
    expect(await getHelmRollbackFlag(helm4Runner)).toBe('--rollback-on-failure');
    expect(helm4Runner.calls).toHaveLength(1);

    // Allowlist accepts both flags
    expect(() =>
      validateHelmArgs(['upgrade', '--install', 'rel', './chart', '--atomic', '--wait'])
    ).not.toThrow();
    expect(() =>
      validateHelmArgs([
        'upgrade',
        '--install',
        'rel',
        './chart',
        '--rollback-on-failure',
        '--wait',
      ])
    ).not.toThrow();
  });

  it('treats deprecation warnings on stderr with exit code 0 as success', async () => {
    const runner = new RealK8sRunner({
      kubectlBin: process.execPath,
      helmBin: process.execPath,
    });
    // Note: RealK8sRunner prepends '--namespace', '<ns>', so pass node script via stdin or check via node -e?
    // RealK8sRunner allowlists the first arg as verb; use Fake/Real or test with 'version' / node?
    // Since node treats '--namespace' as unknown flag unless avoided, we verify with a tiny temp wrapper or shell-less node shim:
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'forgeflow-helm-warn-'));
    const shim = path.join(tmpDir, 'helm-shim');
    fs.writeFileSync(
      shim,
      `#!${process.execPath}\nprocess.stderr.write('WARNING: deprecated flag\\n');\nprocess.stdout.write('v4.0.0\\n');\nprocess.exit(0);\n`,
      { mode: 0o755 }
    );
    try {
      const shimRunner = new RealK8sRunner({ helmBin: shim });
      const res = await shimRunner.helm(['version', '--short']);
      expect(res.stdout).toContain('v4.0.0');
      expect(res.stderr).toContain('WARNING: deprecated flag');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    expect(runner).toBeDefined();
  });

  it('enforces privilege boundary: API routes/modules never import k8s/exec or read worker-kubeconfig', () => {
    const apiDirs = ['modules', 'routes', 'middleware'];
    for (const dir of apiDirs) {
      const fullDir = path.join(API_SRC, dir);
      if (!fs.existsSync(fullDir)) continue;
      for (const entry of fs.readdirSync(fullDir, { recursive: true }) as string[]) {
        if (!entry.endsWith('.ts')) continue;
        const content = fs.readFileSync(path.join(fullDir, entry), 'utf8');
        expect(content).not.toContain('k8s/exec');
        expect(content).not.toContain('worker-kubeconfig');
        expect(content).not.toContain('KUBECONFIG_WORKER_PATH');
      }
    }
  });
});
