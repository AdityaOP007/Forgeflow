# ForgeFlow Threat Model & Security Mitigations

This document outlines the threat model, security posture, and defensive controls implemented across ForgeFlow.

---

## 1. Protected Assets

- **Database & State**: Relational catalog records, user accounts, deployment environments, and workflow executions.
- **User Identity & Access**: Session tokens, user roles (`admin`, `developer`, `viewer`), and authorization state.
- **Service Configuration & Infrastructure**: Repository URLs, template definitions, and environment endpoints.
- **Audit Trails**: Non-repudiation records in `audit_logs` tracking service creation, modification, and deletion.

---

## 2. Threat Analysis & Mitigations

### A. Authentication & Identity Spoofing

| Threat                                     | Risk     | Mitigation                                                                                                                                                                                                                       |
| :----------------------------------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated access to API endpoints    | High     | Strict `clerkAuthVerifier` rejects requests missing or carrying invalid tokens with `401 Unauthorized`.                                                                                                                          |
| Unverified email claiming admin privileges | Critical | `syncClerkUser` fetches user profile directly from Clerk API (`clerkClient.users.getUser`) and checks that the primary email has `verification.status === 'verified'`. Unverified email addresses are never granted admin roles. |
| Email collision / account hijacking        | High     | The `users` table enforces a unique constraint on `email`. `provisionUser` checks existing email associations and returns a `409 Conflict` if an email is already claimed by a different `clerk_id`.                             |
| Concurrent provisioning race condition     | Medium   | User provisioning uses an atomic PostgreSQL `INSERT ... ON CONFLICT (clerk_id) DO UPDATE` query, eliminating select-then-insert race conditions.                                                                                 |

### B. Authorization & Privilege Escalation

| Threat                                            | Risk     | Mitigation                                                                                                                                                                                                                                                                       |
| :------------------------------------------------ | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthorized modification or deletion of services | Critical | Server-side authorization enforced in API service layer. `requireRole(['admin', 'developer'])` guards write endpoints; developers can only edit or delete services where `service.owner_id === req.auth.userId`. Admins can manage all services. Viewers are strictly read-only. |
| UI bypass (manipulating frontend client)          | High     | UI role checks are cosmetic only. Every mutating API route independently verifies identity, role, and ownership server-side.                                                                                                                                                     |
| Accidental admin demotion or privilege race       | Medium   | The `provisionUser` query employs a strict **No-Demotion Policy**: `role` is updated to `admin` when verified matching `ADMIN_EMAILS`, but is never automatically downgraded to `viewer` on repeat logins. Demotions require an explicit administrative action.                  |

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

| Threat                               | Risk     | Mitigation                                                                                                                                                                                             |
| :----------------------------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accidental production database wipe  | Critical | The `db:reset` script contains a production guard refusing execution if `NODE_ENV=production`. Additionally, test cleanup routines throw an error if the connected database does not end with `_test`. |
| Hardcoded secrets in version control | Critical | Credentials and API keys are managed exclusively via `.env` files (enforced by `.gitignore`). Example templates (`.env.example`) contain only parameter names and non-sensitive placeholder values.    |
| Network and CORS exposure            | Medium   | CORS is restricted to `WEB_ORIGIN` (`http://localhost:5173` in development).                                                                                                                           |
