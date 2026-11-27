import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { environments } from '../../db/schema.js';
import type { K8sRunner } from '../../k8s/exec.js';
import { uninstallHelmRelease } from '../../k8s/helm.js';
import type { Step } from '../executor.js';

export const UNDEPLOY_STEP_DEFINITIONS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'validate', name: 'Validate undeploy target' },
  { key: 'helm_uninstall', name: 'Uninstall Helm release & cluster resources' },
  { key: 'cleanup_state', name: 'Clear environment deployment state' },
];

export interface UndeployStepsDeps {
  getK8sRunner: () => K8sRunner | null;
}

export function createUndeploySteps(deps: UndeployStepsDeps): Step[] {
  return [
    {
      key: 'validate',
      name: UNDEPLOY_STEP_DEFINITIONS[0].name,
      run: async (ctx) => {
        if (!ctx.service) {
          throw new Error(`Service '${ctx.run.service_id}' not found`);
        }

        const environmentName = String(ctx.input.environmentName ?? 'development');
        const [env] = await db
          .select()
          .from(environments)
          .where(
            and(
              eq(environments.service_id, ctx.service.id),
              eq(environments.name, environmentName as 'development')
            )
          )
          .limit(1);

        if (!env) {
          throw new Error(`Environment '${environmentName}' not found for service`);
        }

        await ctx.saveResource('environmentId', env.id);
        await ctx.saveResource('releaseName', ctx.service.slug);
      },
    },
    {
      key: 'helm_uninstall',
      name: UNDEPLOY_STEP_DEFINITIONS[1].name,
      run: async (ctx) => {
        const runner = deps.getK8sRunner();
        if (!runner) {
          throw new Error('Kubernetes worker kubeconfig is not configured');
        }

        const releaseName = String(ctx.resources.releaseName);
        const res = await uninstallHelmRelease(runner, releaseName, ctx.service!.slug);
        await ctx.log(
          'info',
          res.uninstalled
            ? `Uninstalled Helm release '${releaseName}' and cleaned up secrets/PVC`
            : `Helm release '${releaseName}' was not present; cleaned up any leftover secrets/PVC`
        );
      },
    },
    {
      key: 'cleanup_state',
      name: UNDEPLOY_STEP_DEFINITIONS[2].name,
      run: async (ctx) => {
        const environmentId = String(ctx.resources.environmentId);
        await db
          .update(environments)
          .set({
            deployed_version: null,
            deployed_image: null,
            deployed_commit_sha: null,
            observed_image: null,
            observed_replicas: null,
            observed_ready_replicas: null,
            node_port: null,
            url: null,
            status: 'unknown',
            last_observed_at: new Date(),
            last_observed_error: null,
          })
          .where(eq(environments.id, environmentId));

        await ctx.log('info', 'Cleared environment deployment state');
      },
    },
  ];
}
