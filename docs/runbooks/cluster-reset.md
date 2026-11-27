# Runbook: Resetting the Local `kind-forgeflow` Cluster

Use this runbook when the local Kubernetes cluster is corrupted, unreachable, or needs a clean slate.

## 1. Tear Down the Cluster

```bash
pnpm k8s:down
```

If `kind` leaves stale containers behind:

```bash
kind delete cluster --name forgeflow
rm -f secrets/worker-kubeconfig.yaml
```

## 2. Recreate the Cluster & Verify RBAC

```bash
pnpm k8s:doctor
pnpm k8s:up
pnpm k8s:verify-rbac
pnpm k8s:status
```

## 3. Reconcile ForgeFlow Database State

- Start `pnpm dev`.
- On the next reconcile interval (`RECONCILE_INTERVAL_MS`, default `15000`), ForgeFlow's cluster reconciler will observe that previously deployed releases are no longer present in `forgeflow-dev`.
- Redeploy any services from their **Deployments** tab in the Web UI (or undeploy stale records if you want a clean environment state).
