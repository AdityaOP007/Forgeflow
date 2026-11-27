# ForgeFlow Architecture

## System Overview

ForgeFlow is an Internal Developer Platform (IDP) designed to streamline microservice scaffolding, repository provisioning, CI/CD automation, and deployment observability.

```text
+-------------------------------------------------------------+
|                      React Web Portal                       |
|          (Vite + Tailwind CSS + TanStack Query)             |
+------------------------------+------------------------------+
                               | HTTP / JSON (camelCase)
                               v
+-------------------------------------------------------------+
|                    Express API Gateway                      |
|  - Local Admin Auth Verifier (Development Mode)             |
|  - Server-Side Role-Based Access Control (RBAC)             |
|  - Zod Request Validation (@forgeflow/shared-types)         |
|  - Structured Audit Logging                                 |
+------------------------------+------------------------------+
                               | SQL / Drizzle ORM
                               v
+-------------------------------------------------------------+
|                    PostgreSQL Database                      |
|  (users, templates, services, environments, runs, audits)   |
+-------------------------------------------------------------+
```

---

## Authentication Architecture

ForgeFlow currently operates in **local development mode**:

- Single built-in local administrator user (`Local Admin`, `admin@forgeflow.local`, role: `admin`).
- Express server binds to `127.0.0.1` and fails startup if `NODE_ENV === 'production'`.
- Database schema retains `users.clerk_id` as an external-auth identity placeholder column (`local-admin`).
- Production Clerk authentication has been saved under git tag `phase-1-clerk` and will be reintroduced alongside enterprise SSO options.

---

## Database Architecture (Phase 1)

ForgeFlow utilizes PostgreSQL managed via **Drizzle ORM**. The platform schema consists of six core relational tables:

```mermaid
erDiagram
    users ||--o{ services : "owns"
    users ||--o{ audit_logs : "triggers"
    templates ||--o{ services : "scaffolds"
    services ||--o{ environments : "deploys to"
    services ||--o{ workflow_runs : "executes"

    users {
        uuid id PK "gen_random_uuid()"
        varchar clerk_id UK "External auth ID placeholder"
        varchar email UK "Unique email address"
        varchar name "Full display name"
        user_role role "'admin' | 'developer' | 'viewer'"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    templates {
        uuid id PK "gen_random_uuid()"
        varchar name "Template display name"
        varchar slug UK "Unique URL-friendly slug"
        varchar language "Primary runtime language"
        varchar framework "Web / microservice framework"
        text description "Template architectural summary"
        varchar version "Semantic version"
        varchar source_location "Git repository / directory"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    services {
        uuid id PK "gen_random_uuid()"
        varchar name "Service name (kebab-case)"
        varchar slug UK "Generated URL-friendly slug"
        text description "Service overview"
        varchar repository_url "Valid http/https Git repository URL"
        uuid template_id FK "References templates.id"
        uuid owner_id FK "References users.id"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    environments {
        uuid id PK "gen_random_uuid()"
        uuid service_id FK "References services.id (CASCADE)"
        varchar name "'production' | 'staging' | 'preview'"
        environment_status status "'healthy' | 'degraded' | 'failed' | 'unknown'"
        varchar url "Public service ingress URL"
        timestamp last_deployed_at "Timestamp of last deploy"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    workflow_runs {
        uuid id PK "gen_random_uuid()"
        uuid service_id FK "References services.id (CASCADE)"
        varchar workflow_type "'ci' | 'deploy' | 'scan'"
        workflow_status status "'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled'"
        varchar commit_sha "Git commit hash"
        varchar commit_message "Commit summary"
        varchar branch "Target Git branch"
        integer duration_ms "Execution time in milliseconds"
        text logs "Console stdout/stderr output"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    audit_logs {
        uuid id PK "gen_random_uuid()"
        uuid user_id FK "References users.id (SET NULL)"
        varchar action "'service.created' | 'service.updated' | 'service.deleted'"
        varchar resource_type "Resource type (e.g. 'service')"
        uuid resource_id "ID of affected resource"
        jsonb details "Contextual audit payload"
        varchar ip_address "Client IP address"
        varchar user_agent "Client user agent"
        timestamp created_at "now()"
    }
```

---

## Phase 2 Workflow Engine & GitHub Integration

### Workflow State Machine

```mermaid
stateDiagram-v2
    [*] --> queued: POST /api/services/scaffold
    queued --> running: Worker claims via FOR UPDATE SKIP LOCKED
    running --> succeeded: All 4 steps succeed
    running --> failed: Step throws / retries exhausted
    queued --> cancelled: POST /api/workflows/:id/cancel
    running --> cancelled: cancel_requested checked before next step
    failed --> queued: POST /api/workflows/:id/retry (resets failed/skipped steps)
```

### Queue & Worker Execution

- **Queue Claiming**: `claimNext(workerId)` selects the oldest `queued` run using PostgreSQL `FOR UPDATE SKIP LOCKED`, transitions it to `running`, increments `attempts`, and sets `locked_at` / `locked_by`.
- **Heartbeat & Stale-Lock Recovery**: While executing steps, the worker refreshes `locked_at` every 15s (`LOCK_HEARTBEAT_MS`). On startup and every 30s, `requeueStale()` recovers any `running` run whose `locked_at` is older than 60s (`STALE_LOCK_MS`), returning it to `queued` (or `failed` if `attempts >= maxAttempts`).
- **Cancellation**: `POST /api/workflows/:id/cancel` cancels `queued` runs immediately or sets `cancel_requested = true` on `running` runs so the executor stops cleanly before starting the next step.

### GitHub Integration Sequence

```mermaid
sequenceDiagram
    participant UI as Web Wizard
    participant API as Express API
    participant DB as PostgreSQL
    participant Worker as Workflow Worker
    participant GH as GitHub API (v2026-03-10)

    UI->>API: POST /api/services/scaffold
    API->>DB: Insert service (provisioning), workflow_run (queued), 4 workflow_steps, audit_log
    API-->>UI: 202 { serviceId, workflowId, status: "queued" }
    Worker->>DB: claimNext() via FOR UPDATE SKIP LOCKED
    Worker->>GH: validate: getInstallationInfo() + getRepository(slug)
    Note over Worker,GH: Fails if foreign repo exists without [forgeflow:<12-hex>] marker
    Worker->>Worker: generate: renderTemplate(python-fastapi)
    Worker->>GH: create_repository: POST /orgs/{org}/repos (description + ownership marker)
    Worker->>GH: push_files: Git Data API (blobs -> tree -> commit -> patch ref) + verify SHA
    Worker->>DB: Mark steps/run succeeded, service provisioning_status='ready'
    UI->>API: Poll GET /api/workflows/:id & /logs until terminal
```

---

## Phase 3 Deployment, Trust Boundaries & Reconcilers

### Deploy Sequence

```mermaid
sequenceDiagram
    participant UI as Web Portal
    participant API as Express API
    participant DB as PostgreSQL
    participant Worker as Workflow Worker
    participant GH as GitHub API
    participant K8s as kind-forgeflow (forgeflow-dev)

    UI->>API: POST /api/services/:id/deployments { environment: "development", commitSha? }
    API->>DB: Insert deployment (queued), workflow_run (deploy, queued), 4 steps
    API-->>UI: 202 { deploymentId, workflowId, status: "queued" }
    Worker->>DB: claimNext() via FOR UPDATE SKIP LOCKED
    Worker->>GH: preflight: verify cluster reachable, chart, GHCR vars, & Publish Image CI success
    Worker->>K8s: prepare: allocate NodePort (30080-30089), upsert GHCR pull & DB secrets
    Worker->>K8s: deploy: helm upgrade --install --atomic (timeout=DEPLOY_TIMEOUT_SECONDS)
    Worker->>K8s: verify: check Deployment readyReplicas, image tag, and HTTP /health/ready
    Worker->>DB: Update environments (healthy, url, observed_*), mark deployment & workflow succeeded
```

### API vs Worker Trust Boundary & Restricted Kubeconfig

- **API process (`apps/api/src/index.ts`)**: Handles HTTP requests, RBAC, Zod validation, webhook HMAC verification, and database writes. It does **not** hold cluster credentials or execute `kubectl`/`helm`.
- **Worker process (`apps/api/src/worker/index.ts`)**: Claims `scaffold`, `deploy`, and `undeploy` jobs from PostgreSQL and interacts with `kind-forgeflow` exclusively through `secrets/worker-kubeconfig.yaml` (scoped to the `forgeflow-worker` ServiceAccount in `forgeflow-dev`).
- **Restricted RBAC**: `infrastructure/kubernetes/rbac.yaml` grants `forgeflow-worker` namespace-scoped permissions inside `forgeflow-dev` only (Deployments, Services, Pods, Secrets, ConfigMaps, PVCs, ReplicaSets, Events) and no cluster-admin or cross-namespace access.

### CI & Cluster Reconcilers

- **CI Sync Reconciler**: Periodically polls GitHub Actions workflow runs and jobs for ready services so `ci_runs` stays current even when local webhooks are not forwarded.
- **Cluster Health Reconciler** (`RECONCILE_INTERVAL_MS`): Periodically queries `forgeflow-dev` Deployments and Pods via `KUBECONFIG_WORKER_PATH` and updates `environments.status` (`healthy`, `degraded`, `failed`, `unknown`), `observed_image`, `observed_replicas`, `observed_ready_replicas`, `last_observed_at`, and `last_observed_error`.
