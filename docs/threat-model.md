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

## 3. Phase 2 Threats: Template Rendering, GitHub App & Workflow Worker

| Threat                                                    | Risk     | Mitigation & Behavior                                                                                                                                                                                                                                                                                                                            |
| :-------------------------------------------------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template injection (`__SERVICE_NAME__`) & path traversal  | High     | `renderTemplate()` performs single-pass token replacement (never double-expanding user descriptions), `validateRenderedPaths()` rejects any path with `..`, leading `/`, or `\`, and `README.md` descriptions are excluded from template Ruff linting (`extend-exclude = ["README.md"]`).                                                        |
| GitHub token & private key leakage                        | Critical | `.env` and `secrets/*.pem` are gitignored. `redactSecrets()` strips `ghs_`, `ghp_`, `github_pat_`, `Bearer` tokens, and `-----BEGIN ... PRIVATE KEY-----` blocks from all error summaries, workflow logs, and API responses.                                                                                                                     |
| API process reading GitHub private key (Known Limitation) | Medium   | The Express API process reads `GITHUB_APP_PRIVATE_KEY_PATH` solely to serve `GET /api/integrations/github` connectivity status. In a future hardening pass, status probing can be delegated to the worker or cached out-of-band so the API process never touches the private key.                                                                |
| Over-privileged GitHub App scope                          | High     | The GitHub App requests only the minimum permissions required: **Administration: Write**, **Contents: Write**, **Workflows: Write**, and **Metadata: Read**.                                                                                                                                                                                     |
| Repository name collisions / hijacking                    | High     | `create_repository` embeds `[forgeflow:<12-hex>]` (derived from `service.id`) in the GitHub repository description. During `validate` and retries, `getRepository()` fails with a clear error if an existing repository lacks that service's ownership marker.                                                                                   |
| Worker crash / stale lock                                 | Medium   | Workers refresh `locked_at` on a 15s heartbeat. `requeueStale()` recovers runs locked longer than 60s back to `queued` (up to `maxAttempts`) so crashed runs do not stay stuck indefinitely.                                                                                                                                                     |
| Cancellation leaves partial external resources            | Low      | Cancelling a running workflow stops execution before the next step, marks remaining steps `skipped`, and intentionally performs **no automatic deletion** of any GitHub repository already created; the UI displays completed steps, created resources, and a clear notice.                                                                      |
| Newly published GHCR packages may default to public       | Medium   | GitHub Actions `Publish Image` may create a new GHCR package with public visibility depending on organization settings. Operators should check newly published packages in GitHub Packages settings and set visibility to **Private**; ForgeFlow's worker uses `GHCR_PULL_TOKEN` (`read:packages`) and `DEPLOY_TIMEOUT_SECONDS` (default `600`). |

---

## 3. Phase 2 Threats: Template Rendering, GitHub App & Workflow Worker

| Threat                                                    | Risk     | Mitigation & Behavior                                                                                                                                                                                                                                                                                                                            |
| :-------------------------------------------------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template injection (`__SERVICE_NAME__`) & path traversal  | High     | `renderTemplate()` performs single-pass token replacement (never double-expanding user descriptions), `validateRenderedPaths()` rejects any path with `..`, leading `/`, or `\`, and `README.md` descriptions are excluded from template Ruff linting (`extend-exclude = ["README.md"]`).                                                        |
| GitHub token & private key leakage                        | Critical | `.env` and `secrets/*.pem` are gitignored. `redactSecrets()` strips `ghs_`, `ghp_`, `github_pat_`, `Bearer` tokens, and `-----BEGIN ... PRIVATE KEY-----` blocks from all error summaries, workflow logs, and API responses.                                                                                                                     |
| API process reading GitHub private key (Known Limitation) | Medium   | The Express API process reads `GITHUB_APP_PRIVATE_KEY_PATH` solely to serve `GET /api/integrations/github` connectivity status. In a future hardening pass, status probing can be delegated to the worker or cached out-of-band so the API process never touches the private key.                                                                |
| Over-privileged GitHub App scope                          | High     | The GitHub App requests only the minimum permissions required: **Administration: Write**, **Contents: Write**, **Workflows: Write**, and **Metadata: Read**.                                                                                                                                                                                     |
| Repository name collisions / hijacking                    | High     | `create_repository` embeds `[forgeflow:<12-hex>]` (derived from `service.id`) in the GitHub repository description. During `validate` and retries, `getRepository()` fails with a clear error if an existing repository lacks that service's ownership marker.                                                                                   |
| Worker crash / stale lock                                 | Medium   | Workers refresh `locked_at` on a 15s heartbeat. `requeueStale()` recovers runs locked longer than 60s back to `queued` (up to `maxAttempts`) so crashed runs do not stay stuck indefinitely.                                                                                                                                                     |
| Cancellation leaves partial external resources            | Low      | Cancelling a running workflow stops execution before the next step, marks remaining steps `skipped`, and intentionally performs **no automatic deletion** of any GitHub repository already created; the UI displays completed steps, created resources, and a clear notice.                                                                      |
| Newly published GHCR packages may default to public       | Medium   | GitHub Actions `Publish Image` may create a new GHCR package with public visibility depending on organization settings. Operators should check newly published packages in GitHub Packages settings and set visibility to **Private**; ForgeFlow's worker uses `GHCR_PULL_TOKEN` (`read:packages`) and `DEPLOY_TIMEOUT_SECONDS` (default `600`). |
