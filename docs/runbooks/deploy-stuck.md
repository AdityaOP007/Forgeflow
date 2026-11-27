# Runbook: Deployment Stuck or Failing in `forgeflow-dev`

## Symptoms

- A deploy workflow stays in `running` for longer than expected, or fails in `deploy` / `verify` with `context deadline exceeded`, `ImagePullBackOff`, `ErrImagePull`, or `CrashLoopBackOff`.
- An environment shows `degraded` or `failed` in the ForgeFlow UI.

## Diagnosis

1. **Check worker and workflow state**:
   - Inspect the workflow detail page (`/workflows/<id>`) for the failed step (`preflight`, `prepare`, `deploy`, `verify`) and execution logs.
   - Confirm the worker process is running (`pnpm --filter @forgeflow/api dev:worker` or `pnpm dev`).

2. **Inspect pods and events in `forgeflow-dev`**:

```bash
kubectl --context kind-forgeflow -n forgeflow-dev get pods,deployments,events --sort-by=.lastTimestamp
kubectl --context kind-forgeflow -n forgeflow-dev describe pod -l app.kubernetes.io/instance=<service-slug>
kubectl --context kind-forgeflow -n forgeflow-dev logs -l app.kubernetes.io/instance=<service-slug> --tail=100
```

3. **Check Helm release history**:

```bash
helm --kube-context kind-forgeflow -n forgeflow-dev status <service-slug>
helm --kube-context kind-forgeflow -n forgeflow-dev history <service-slug>
```

## Common Causes & Fixes

- **`ImagePullBackOff` / `unauthorized`**:
  - Verify `GHCR_PULL_USERNAME` and `GHCR_PULL_TOKEN` in `apps/api/.env` (classic PAT with `read:packages`).
  - Restart the worker after updating `.env` so it picks up the new token, then trigger a new deploy or click **Retry** on the failed workflow.
- **Slow first image pull timeout**:
  - Increase `DEPLOY_TIMEOUT_SECONDS` (default `600`) in `apps/api/.env` or process environment and restart the worker.
- **Database connection or readiness failure**:
  - Check the service's Postgres pod (`<service-slug>-postgres`) and `<service-slug>-db-secret` in `forgeflow-dev`.
- **Helm release stuck in `pending-upgrade` / `pending-install`**:
  - Run `helm --kube-context kind-forgeflow -n forgeflow-dev rollback <service-slug> <last-good-rev>` or undeploy from the Service **Deployments** tab.
