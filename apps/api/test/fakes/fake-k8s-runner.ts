import {
  validateHelmArgs,
  validateKubectlArgs,
  type K8sExecOptions,
  type K8sExecResult,
  type K8sRunner,
} from '../../src/k8s/exec.js';

export interface RecordedK8sCall {
  tool: 'kubectl' | 'helm';
  args: string[];
  stdin?: string;
}

export type ScriptedK8sHandler = (
  args: string[],
  opts?: K8sExecOptions
) => K8sExecResult | Promise<K8sExecResult>;

export class FakeK8sRunner implements K8sRunner {
  readonly calls: RecordedK8sCall[] = [];
  private kubectlHandlers: ScriptedK8sHandler[] = [];
  private helmHandlers: ScriptedK8sHandler[] = [];
  private defaultKubectl: ScriptedK8sHandler = () => ({ stdout: '', stderr: '' });
  private defaultHelm: ScriptedK8sHandler = () => ({ stdout: '', stderr: '' });

  onKubectl(handler: ScriptedK8sHandler): this {
    this.kubectlHandlers.push(handler);
    return this;
  }

  onHelm(handler: ScriptedK8sHandler): this {
    this.helmHandlers.push(handler);
    return this;
  }

  setDefaultKubectl(handler: ScriptedK8sHandler): this {
    this.defaultKubectl = handler;
    return this;
  }

  setDefaultHelm(handler: ScriptedK8sHandler): this {
    this.defaultHelm = handler;
    return this;
  }

  async kubectl(args: string[], opts: K8sExecOptions = {}): Promise<K8sExecResult> {
    validateKubectlArgs(args);
    this.calls.push({ tool: 'kubectl', args: [...args], stdin: opts.stdin });
    const handler = this.kubectlHandlers.shift() ?? this.defaultKubectl;
    return handler(args, opts);
  }

  async helm(args: string[], opts: K8sExecOptions = {}): Promise<K8sExecResult> {
    validateHelmArgs(args);
    this.calls.push({ tool: 'helm', args: [...args], stdin: opts.stdin });
    const handler = this.helmHandlers.shift() ?? this.defaultHelm;
    return handler(args, opts);
  }
}
