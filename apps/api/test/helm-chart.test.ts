import { describe, it } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHART_PATH = path.resolve(__dirname, '../../../infrastructure/helm/service-chart');

function isHelmInstalled(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasHelm = isHelmInstalled();
const describeHelm = hasHelm ? describe : describe.skip;

if (!hasHelm) {
  console.warn('[helm-chart.test.ts] Skipping Helm chart tests: helm binary is not installed.');
}

describeHelm('Helm service-chart — Checkpoint 3A', () => {
  const validSetArgs = [
    '--set',
    'image.repository=ghcr.io/forgeflow-aditya/demo-service',
    '--set',
    'image.tag=0123456789abcdef0123456789abcdef01234567',
    '--set',
    'nodePort=30080',
    '--set',
    'database.existingSecret=demo-service-db',
  ];

  it('helm lint passes with valid required values', () => {
    const out = execFileSync('helm', ['lint', CHART_PATH, ...validSetArgs], {
      encoding: 'utf8',
    });
    expect(out).toContain('0 chart(s) failed');
  });

  it('helm template renders Deployment, NodePort Service, StatefulSet, headless Service, probes, securityContext, and labels without Secret objects', () => {
    const rendered = execFileSync(
      'helm',
      ['template', 'demo-service', CHART_PATH, ...validSetArgs],
      { encoding: 'utf8' }
    );

    expect(rendered).toContain('kind: Deployment');
    expect(rendered).toContain('kind: Service');
    expect(rendered).toContain('type: NodePort');
    expect(rendered).toContain('nodePort: 30080');
    expect(rendered).toContain('kind: StatefulSet');
    expect(rendered).toContain('clusterIP: None');
    expect(rendered).toContain('name: wait-for-db');
    expect(rendered).toContain('path: /health/ready');
    expect(rendered).toContain('path: /health');
    expect(rendered).toContain('runAsNonRoot: true');
    expect(rendered).toContain('runAsUser: 10001');
    expect(rendered).toContain('allowPrivilegeEscalation: false');
    expect(rendered).toContain('app.kubernetes.io/managed-by: forgeflow');
    expect(rendered).toContain('forgeflow.io/environment: development');
    expect(rendered).toContain('forgeflow.io/commit-sha:');
    expect(rendered).not.toContain('kind: Secret');
  });

  it('fails when required values are missing', () => {
    expect(() =>
      execFileSync(
        'helm',
        [
          'template',
          'demo-service',
          CHART_PATH,
          '--set',
          'image.tag=abc',
          '--set',
          'nodePort=30080',
          '--set',
          'database.existingSecret=demo-db',
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      )
    ).toThrow();

    expect(() =>
      execFileSync(
        'helm',
        [
          'template',
          'demo-service',
          CHART_PATH,
          '--set',
          'image.repository=ghcr.io/a/b',
          '--set',
          'nodePort=30080',
          '--set',
          'database.existingSecret=demo-db',
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      )
    ).toThrow();

    expect(() =>
      execFileSync(
        'helm',
        [
          'template',
          'demo-service',
          CHART_PATH,
          '--set',
          'image.repository=ghcr.io/a/b',
          '--set',
          'image.tag=abc',
          '--set',
          'database.existingSecret=demo-db',
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      )
    ).toThrow();

    expect(() =>
      execFileSync(
        'helm',
        [
          'template',
          'demo-service',
          CHART_PATH,
          '--set',
          'image.repository=ghcr.io/a/b',
          '--set',
          'image.tag=abc',
          '--set',
          'nodePort=30080',
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      )
    ).toThrow();
  });
});
