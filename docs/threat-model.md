# ForgeFlow Threat Model & Security Mitigations

This document outlines the threat model, security posture, and defensive controls implemented across ForgeFlow.

---

## 1. Protected Assets

- **Database & State**: Relational catalog records, user accounts, deployment environments, and workflow executions.
- **User Identity & Access**: User roles (`admin`, `developer`, `viewer`) and authorization state.
- **Service Configuration & Infrastructure**: Repository URLs, template definitions, and environment endpoints.
- **Audit Trails**: Non-repudiation records in `audit_logs` tracking service creation, modification, and deletion.

---

## 2. Threat Analysis & Mitigations

### A. Authentication & Local Development Mode

| Threat                                      | Risk     | Mitigation                                                                                                                                                                                                        |
| :------------------------------------------ | :------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accidental deployment of local auth to prod | Critical | Hard safety rule in `apps/api/src/config/env.ts`: if `NODE_ENV === 'production'`, startup throws a fatal error: `"Local auth cannot be used in production"`.                                                      |
| Network exposure of unauthenticated API     | High     | The Express server explicitly binds to `127.0.0.1` (loopback only) rather than `0.0.0.0`. CORS is strictly restricted to `WEB_ORIGIN` (default `http://localhost:5173`).                                          |
| Header injection / token confusion          | Medium   | The local auth verifier ignores any incoming `Authorization` headers entirely, resolving only to the local administrator row.                                                                                     |
| Concurrent startup user provisioning race   | Medium   | User provisioning uses an atomic PostgreSQL `INSERT ... ON CONFLICT (clerk_id) DO UPDATE` query on each request, eliminating select-then-insert race conditions.                                                  |
| External Identity Decoupling                | Low      | The `clerk_id` column is maintained as an external-auth identity placeholder. Full Clerk auth is preserved in git tag `phase-1-clerk` and will be reintroduced later alongside an enterprise SSO provider option. |

### B. Authorization & Privilege Escalation

| Threat                                            | Risk     | Mitigation                                                                                                                                                                                                                                                                       |
| :------------------------------------------------ | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthorized modification or deletion of services | Critical | Server-side authorization enforced in API service layer. `requireRole(['admin', 'developer'])` guards write endpoints; developers can only edit or delete services where `service.owner_id === req.auth.userId`. Admins can manage all services. Viewers are strictly read-only. |
| UI bypass (manipulating frontend client)          | High     | UI role checks are cosmetic only. Every mutating API route independently verifies identity, role, and ownership server-side.                                                                                                                                                     |
| Client-side role tampering                        | Medium   | The frontend derives all role permissions directly from the `/api/me` response. No client-side role switcher, dev buttons, or localStorage overrides exist.                                                                                                                      |

### C. Input Validation & Injection Attacks

| Threat                                               | Risk     | Mitigation                                                                                                                                                                                                                                                                                                                         |
| :--------------------------------------------------- | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path traversal or command injection in service names | High     | Service names are validated using `serviceNameSchema` via Zod. Names must match `^[a-z0-9-]+$` (kebab-case, 3 to 63 characters), completely disallowing `../`, slashes, spaces, uppercase letters, or special characters.                                                                                                          |
| Cross-Site Scripting (XSS) via `repositoryUrl`       | High     | `repositoryUrlSchema` restricts protocols strictly to `http:` and `https:` by parsing through `new URL()`. Protocols like `javascript:`, `data:`, `file:`, or `ftp:` are rejected with a clear 400 validation error. URL length is constrained to `.max(2048)`. Empty strings and whitespace-only strings are sanitized to `null`. |
| Database SQL injection                               | Critical | All database operations use parameterized queries generated by **Drizzle ORM**; no raw SQL concatenation is permitted.                                                                                                                                                                                                             |

### D. Auditability & Non-Repudiation

| Threat                                  | Risk   | Mitigation                                                                                                                                                                                                                              |
| :-------------------------------------- | :----- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untracked destructive operations        | Medium | Every service creation, update, and deletion writes an immutable entry to `audit_logs` containing the actor's `userId`, action (`service.created`, `service.updated`, `service.deleted`), target resource, and structured JSON details. |
| Tampered audit history on user deletion | Low    | `audit_logs.user_id` uses `ON DELETE SET NULL`, preserving the action history and metadata even if the actor account is removed.                                                                                                        |

### E. Operational & Infrastructure Security

| Threat                             | Risk     | Mitigation                                                                                                                                                                            |
| :--------------------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accidental test cleanup on prod DB | Critical | The test suite cleanup helper `cleanTables()` queries `SELECT current_database()` and throws a fatal error unless the connected database name ends with `_test`.                      |
| HTTP header vulnerabilities        | Medium   | `helmet` middleware configures standard secure HTTP response headers (HSTS, X-Content-Type-Options, etc.).                                                                            |
| Denial of Service (DoS) on API     | Medium   | Express `express-rate-limit` enforces 100 requests per minute on `/api` routes with standard HTTP 429 response codes, and `express.json({ limit: '100kb' })` caps body payload sizes. |

---

## 4. Phase 3 Threats: Kubernetes Deployments, GHCR & Webhooks

| Threat                                               | Risk     | Mitigation & Behavior                                                                                                                                                                                                                                              |
| :--------------------------------------------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Over-privileged Kubernetes access                    | Critical | The worker uses `secrets/worker-kubeconfig.yaml` bound to the `forgeflow-worker` ServiceAccount scoped strictly to `forgeflow-dev` via Role/RoleBinding (`infrastructure/kubernetes/rbac.yaml`), verified by `pnpm k8s:verify-rbac`.                               |
| Kubeconfig & GHCR token exposure                     | Critical | `secrets/worker-kubeconfig.yaml` and `.env` are gitignored; `redactSecrets()` strips `GHCR_PULL_TOKEN`, `dockerconfigjson` payloads, `ghp_`/`ghs_`/`github_pat_` tokens, and database passwords from API responses, workflow logs, and error summaries.            |
| GHCR classic-token limitation                        | Medium   | GitHub Container Registry requires a classic PAT (`read:packages`) for `GHCR_PULL_TOKEN` when pulling private packages; fine-grained PATs do not support GHCR package pulls reliably.                                                                              |
| Worker reading Secrets in `forgeflow-dev`            | Medium   | The `forgeflow-worker` Role permits `get`/`list`/`create`/`update`/`delete` on `Secrets` inside `forgeflow-dev` so it can provision `<slug>-ghcr-pull` and `<slug>-db-secret`. It has no access to `kube-system` or other namespaces.                              |
| Forged or replayed GitHub webhooks                   | High     | `POST /api/webhooks/github` enforces a 256 KB raw body cap (`413`), `application/json` check (`415`), `60 req/min` rate limit, `crypto.timingSafeEqual` HMAC-SHA256 verification before any DB access, and `webhook_deliveries` replay deduplication.              |
| Command / argument injection in `kubectl` / `helm`   | Critical | `apps/api/src/k8s/exec.ts` uses `execFile` (no shell) with strict subcommand allowlists (`kubectl`: `get`, `create`, `apply`, `delete`, `cluster-info`, `auth`; `helm`: `upgrade`, `uninstall`, `status`, `history`, `list`) and rejects `--kubeconfig` overrides. |
| Arbitrary container image deployment                 | High     | `deploy` preflight validates `ghcr.io/<org>/<repo>:<40-hex-sha>` against the service's GitHub repo and confirms `Publish Image` succeeded in CI before running Helm.                                                                                               |
| Host network exposure of NodePorts                   | Medium   | `infrastructure/kubernetes/kind-config.yaml` binds mapped NodePorts (`30080`–`30089`) strictly to `127.0.0.1` (`listenAddress: 127.0.0.1`), and the UI validates links via `isSafeApplicationUrl()`.                                                               |
| Database secret handling                             | High     | Per-service Postgres credentials for deployed apps are generated and stored in `<slug>-db-secret` in `forgeflow-dev` via `kubectl apply -f -` on stdin, never logged or returned by the API.                                                                       |
| Failed deploy leaving broken release / partial state | Medium   | Helm uses `--atomic --rollback-on-failure` (within `DEPLOY_TIMEOUT_SECONDS`, default `600`) to roll back failed upgrades automatically; ForgeFlow performs **no automatic undeploy/cleanup** on failed deploys so operators can inspect pod events and logs.       |

---

## 4. Phase 3 Threats: Kubernetes Deployments, GHCR & Webhooks

| Threat                                               | Risk     | Mitigation & Behavior                                                                                                                                                                                                                                              |
| :--------------------------------------------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Over-privileged Kubernetes access                    | Critical | The worker uses `secrets/worker-kubeconfig.yaml` bound to the `forgeflow-worker` ServiceAccount scoped strictly to `forgeflow-dev` via Role/RoleBinding (`infrastructure/kubernetes/rbac.yaml`), verified by `pnpm k8s:verify-rbac`.                               |
| Kubeconfig & GHCR token exposure                     | Critical | `secrets/worker-kubeconfig.yaml` and `.env` are gitignored; `redactSecrets()` strips `GHCR_PULL_TOKEN`, `dockerconfigjson` payloads, `ghp_`/`ghs_`/`github_pat_` tokens, and database passwords from API responses, workflow logs, and error summaries.            |
| GHCR classic-token limitation                        | Medium   | GitHub Container Registry requires a classic PAT (`read:packages`) for `GHCR_PULL_TOKEN` when pulling private packages; fine-grained PATs do not support GHCR package pulls reliably.                                                                              |
| Worker reading Secrets in `forgeflow-dev`            | Medium   | The `forgeflow-worker` Role permits `get`/`list`/`create`/`update`/`delete` on `Secrets` inside `forgeflow-dev` so it can provision `<slug>-ghcr-pull` and `<slug>-db-secret`. It has no access to `kube-system` or other namespaces.                              |
| Forged or replayed GitHub webhooks                   | High     | `POST /api/webhooks/github` enforces a 256 KB raw body cap (`413`), `application/json` check (`415`), `60 req/min` rate limit, `crypto.timingSafeEqual` HMAC-SHA256 verification before any DB access, and `webhook_deliveries` replay deduplication.              |
| Command / argument injection in `kubectl` / `helm`   | Critical | `apps/api/src/k8s/exec.ts` uses `execFile` (no shell) with strict subcommand allowlists (`kubectl`: `get`, `create`, `apply`, `delete`, `cluster-info`, `auth`; `helm`: `upgrade`, `uninstall`, `status`, `history`, `list`) and rejects `--kubeconfig` overrides. |
| Arbitrary container image deployment                 | High     | `deploy` preflight validates `ghcr.io/<org>/<repo>:<40-hex-sha>` against the service's GitHub repo and confirms `Publish Image` succeeded in CI before running Helm.                                                                                               |
| Host network exposure of NodePorts                   | Medium   | `infrastructure/kubernetes/kind-config.yaml` binds mapped NodePorts (`30080`–`30089`) strictly to `127.0.0.1` (`listenAddress: 127.0.0.1`), and the UI validates links via `isSafeApplicationUrl()`.                                                               |
| Database secret handling                             | High     | Per-service Postgres credentials for deployed apps are generated and stored in `<slug>-db-secret` in `forgeflow-dev` via `kubectl apply -f -` on stdin, never logged or returned by the API.                                                                       |
| Failed deploy leaving broken release / partial state | Medium   | Helm uses `--atomic --rollback-on-failure` (within `DEPLOY_TIMEOUT_SECONDS`, default `600`) to roll back failed upgrades automatically; ForgeFlow performs **no automatic undeploy/cleanup** on failed deploys so operators can inspect pod events and logs.       |
