# Runbook: Stuck Workflow Recovery

## Symptoms

A workflow run remains in `running` status in `workflow_runs` without progressing, typically because a worker process crashed or lost network connectivity before releasing its lock.

## Automatic Recovery

The workflow worker automatically runs `requeueStale()` on startup and every 30 seconds, requeueing any `running` run whose `locked_at` timestamp is older than 60 seconds (when `attempts < max_attempts`).

## Manual Inspection & Recovery (SQL)

### 1. Find stuck `running` workflows

```sql
SELECT
  id,
  service_id,
  type,
  status,
  attempts,
  max_attempts,
  locked_by,
  locked_at,
  started_at
FROM workflow_runs
WHERE status = 'running'
  AND locked_at < NOW() - INTERVAL '60 seconds'
ORDER BY started_at ASC;
```

### 2. Inspect steps for a stuck run

```sql
SELECT
  position,
  key,
  status,
  started_at,
  completed_at,
  error_summary
FROM workflow_steps
WHERE workflow_run_id = '<workflow-run-id>'
ORDER BY position ASC;
```

### 3. Requeue a stuck run manually

If `attempts < max_attempts` and you want the worker to claim and resume the run immediately:

```sql
UPDATE workflow_runs
SET
  status = 'queued',
  locked_at = NULL,
  locked_by = NULL
WHERE id = '<workflow-run-id>'
  AND status = 'running';
```

### 4. Mark an unrecoverable run as `failed`

If the run has exhausted retries or should be stopped manually:

```sql
UPDATE workflow_runs
SET
  status = 'failed',
  locked_at = NULL,
  locked_by = NULL,
  completed_at = NOW(),
  error_summary = 'Manually marked failed by operator during stuck-workflow recovery'
WHERE id = '<workflow-run-id>'
  AND status = 'running';
```
