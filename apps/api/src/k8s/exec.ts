import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { redactSecrets } from '../utils/redact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../');

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_KUBECTL_VERBS = new Set([
  'get',
  'apply',
  'delete',
  'rollout',
  'auth',
  'version',
]);

export const ALLOWED_HELM_SUBCOMMANDS = new Set([
  'upgrade',
  'uninstall',
  'status',
  'history',
  'get',
  'list',
  'lint',
  'template',
  'version',
]);

const FORBIDDEN_FLAGS = [
  '--kubeconfig',
  '--context',
  '--namespace',
  '-n',
  '--all-namespaces',
  '-A',
  '--token',
  '--server',
];

export interface K8sExecOptions {
  stdin?: string;
  timeoutMs?: number;
}

export interface K8sExecResult {
  stdout: string;
  stderr: string;
}

export interface K8sRunner {
  kubectl(args: string[], opts?: K8sExecOptions): Promise<K8sExecResult>;
  helm(args: string[], opts?: K8sExecOptions): Promise<K8sExecResult>;
}

export class K8sArgValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'K8sArgValidationError';
  }
}

export class K8sCommandError extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stdout: string, stderr: string) {
    super(redactSecrets(message));
    this.name = 'K8sCommandError';
    this.exitCode = exitCode;
    this.stdout = redactSecrets(stdout);
    this.stderr = redactSecrets(stderr);
  }
}

function checkArgSafety(args: string[]): void {
  if (!Array.isArray(args) || args.length === 0) {
    throw new K8sArgValidationError('Command arguments must be a non-empty array');
  }

  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new K8sArgValidationError('All command arguments must be strings');
    }
    if (arg.includes('\n') || arg.includes('\r') || arg.includes('\0')) {
      throw new K8sArgValidationError('Command arguments must not contain newlines or NUL bytes');
    }
    for (const forbidden of FORBIDDEN_FLAGS) {
      if (arg === forbidden || arg.startsWith(`${forbidden}=`)) {
        throw new K8sArgValidationError(`Forbidden flag '${forbidden}' supplied by caller`);
      }
    }
  }
}

export function validateKubectlArgs(args: string[]): void {
  checkArgSafety(args);
  const verb = args[0];
  if (!ALLOWED_KUBECTL_VERBS.has(verb)) {
    throw new K8sArgValidationError(`kubectl verb '${verb}' is not in the allowlist`);
  }
  if (verb === 'apply') {
    const fIndex = args.indexOf('-f');
    const hasDashStdin = fIndex !== -1 && args[fIndex + 1] === '-';
    if (!hasDashStdin) {
      throw new K8sArgValidationError("kubectl apply must use '-f -' with manifest on stdin");
    }
  }
}

export function validateHelmArgs(args: string[]): void {
  checkArgSafety(args);
  const subcommand = args[0];
  if (!ALLOWED_HELM_SUBCOMMANDS.has(subcommand)) {
    throw new K8sArgValidationError(`helm subcommand '${subcommand}' is not in the allowlist`);
  }
}

export function parseHelmMajorVersion(versionOutput: string): number {
  const match = versionOutput.match(/v?(\d+)\.\d+/);
  if (!match) {
    throw new Error(`Unable to parse Helm major version from '${versionOutput.trim()}'`);
  }
  return Number(match[1]);
}

export function helmRollbackFlagForMajor(major: number): '--atomic' | '--rollback-on-failure' {
  return major >= 4 ? '--rollback-on-failure' : '--atomic';
}

const helmMajorCache = new WeakMap<K8sRunner, number>();

export async function getHelmMajorVersion(runner: K8sRunner): Promise<number> {
  const cached = helmMajorCache.get(runner);
  if (cached !== undefined) return cached;
  const res = await runner.helm(['version', '--short']);
  const major = parseHelmMajorVersion(res.stdout);
  helmMajorCache.set(runner, major);
  return major;
}

export async function getHelmRollbackFlag(
  runner: K8sRunner
): Promise<'--atomic' | '--rollback-on-failure'> {
  const major = await getHelmMajorVersion(runner);
  return helmRollbackFlagForMajor(major);
}

export interface RealK8sRunnerOptions {
  kubeconfigPath?: string;
  namespace?: string;
  kubectlBin?: string;
  helmBin?: string;
  defaultTimeoutMs?: number;
}

export class RealK8sRunner implements K8sRunner {
  private readonly kubeconfigPath: string;
  private readonly namespace: string;
  private readonly kubectlBin: string;
  private readonly helmBin: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: RealK8sRunnerOptions = {}) {
    const rawKubeconfig =
      options.kubeconfigPath ??
      process.env.KUBECONFIG_WORKER_PATH ??
      'secrets/worker-kubeconfig.yaml';
    this.kubeconfigPath = path.isAbsolute(rawKubeconfig)
      ? rawKubeconfig
      : path.resolve(REPO_ROOT, rawKubeconfig);
    this.namespace = options.namespace ?? process.env.K8S_NAMESPACE ?? 'forgeflow-dev';
    this.kubectlBin = options.kubectlBin ?? 'kubectl';
    this.helmBin = options.helmBin ?? 'helm';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async kubectl(args: string[], opts: K8sExecOptions = {}): Promise<K8sExecResult> {
    validateKubectlArgs(args);
    const fullArgs = ['--namespace', this.namespace, ...args];
    return this.execBinary(this.kubectlBin, fullArgs, opts);
  }

  async helm(args: string[], opts: K8sExecOptions = {}): Promise<K8sExecResult> {
    validateHelmArgs(args);
    const fullArgs = ['--namespace', this.namespace, ...args];
    return this.execBinary(this.helmBin, fullArgs, opts);
  }

  private execBinary(bin: string, args: string[], opts: K8sExecOptions): Promise<K8sExecResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      KUBECONFIG: this.kubeconfigPath,
    };

    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let totalBytes = 0;
      let killedForLimit = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const appendChunk = (chunk: Buffer, target: 'stdout' | 'stderr') => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          killedForLimit = true;
          child.kill('SIGKILL');
          return;
        }
        const text = chunk.toString('utf8');
        if (target === 'stdout') stdout += text;
        else stderr += text;
      };

      child.stdout.on('data', (chunk: Buffer) => appendChunk(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => appendChunk(chunk, 'stderr'));

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new K8sCommandError(`${bin} failed to start: ${err.message}`, null, stdout, stderr));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new K8sCommandError(`${bin} timed out after ${timeoutMs}ms`, code, stdout, stderr)
          );
          return;
        }
        if (killedForLimit) {
          reject(
            new K8sCommandError(
              `${bin} output exceeded ${MAX_OUTPUT_BYTES} bytes`,
              code,
              stdout,
              stderr
            )
          );
          return;
        }
        if (code !== 0) {
          reject(
            new K8sCommandError(
              `${bin} ${args[2] ?? ''} exited with code ${code}: ${stderr || stdout}`,
              code,
              stdout,
              stderr
            )
          );
          return;
        }
        resolve({
          stdout: redactSecrets(stdout),
          stderr: redactSecrets(stderr),
        });
      });

      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();
    });
  }
}
