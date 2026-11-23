# ForgeFlow Architecture

## System Overview

ForgeFlow is an Internal Developer Platform (IDP) designed to streamline microservice scaffolding, repository provisioning, CI/CD automation, and deployment observability.

```text
+-------------------------------------------------------------+
|                      React Web Portal                       |
|               (Vite + Tailwind CSS + Clerk)                 |
+------------------------------+------------------------------+
                               | HTTPS / JSON (camelCase)
                               v
+-------------------------------------------------------------+
|                    Express API Gateway                      |
|  - Clerk JWT Authentication & User Sync                     |
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
        varchar clerk_id UK "Unique Clerk user ID"
        varchar email UK "Unique verified email"
        varchar name "Full display name"
        user_role role "'admin' | 'developer' | 'viewer'"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    templates {
        uuid id PK "gen_random_uuid()"
        varchar name UK "Display title"
        varchar slug UK "URL-friendly identifier"
        text description "Template description"
        varchar language "Primary language"
        varchar framework "Framework name"
        varchar version "Semantic version"
        varchar source_location "Repository or disk path"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    services {
        uuid id PK "gen_random_uuid()"
        varchar name UK "Unique service name (kebab-case)"
        text description "Service purpose"
        uuid owner_id FK "users.id (CASCADE)"
        uuid template_id FK "templates.id (SET NULL)"
        varchar repository_url "HTTP/HTTPS repository URL"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    environments {
        uuid id PK "gen_random_uuid()"
        uuid service_id FK "services.id (CASCADE)"
        varchar name "Environment name (dev, staging, prod)"
        env_status status "'pending' | 'deploying' | 'healthy' | 'degraded' | 'failed'"
        varchar url "Ingress endpoint URL"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    workflow_runs {
        uuid id PK "gen_random_uuid()"
        uuid service_id FK "services.id (CASCADE)"
        run_status status "'queued' | 'in_progress' | 'succeeded' | 'failed'"
        varchar trigger_event "Event (create_service, manual, commit)"
        varchar commit_sha "Git commit hash"
        text logs "Execution output logs"
        timestamp created_at "now()"
        timestamp updated_at "now()"
    }

    audit_logs {
        uuid id PK "gen_random_uuid()"
        uuid user_id FK "users.id (SET NULL)"
        varchar action "Action performed (e.g. service.created)"
        varchar resource_type "Target entity type (e.g. service)"
        uuid resource_id "Target entity UUID"
        jsonb details "Payload metadata (diff, parameters)"
        timestamp created_at "now()"
    }
```

### Foreign Key & Cascade Relationships

- **`services.owner_id`**: References `users.id` with `ON DELETE CASCADE`. If a user is deleted, their owned services are deleted.
- **`services.template_id`**: References `templates.id` with `ON DELETE SET NULL`. If a template is decommissioned, existing services retain their catalog identity.
- **`environments.service_id`**: References `services.id` with `ON DELETE CASCADE`. Deleting a service purges all associated deployment environments.
- **`workflow_runs.service_id`**: References `services.id` with `ON DELETE CASCADE`. Deleting a service purges execution logs.
- **`audit_logs.user_id`**: References `users.id` with `ON DELETE SET NULL`. Audit records are preserved for security compliance even if an actor account is deleted.

---

## Authentication & Authorization Model

ForgeFlow implements a decoupled identity and authorization architecture:

1. **Authentication Provider**: Clerk handles authentication, session tokens, and identity lifecycle.
2. **Identity Verification**:
   - The API server verifies incoming Bearer JWT tokens via `clerkMiddleware()`.
   - The verified `userId` is used to fetch the user profile directly from the Clerk backend via `clerkClient.users.getUser(userId)`.
   - The primary email address is inspected: only email addresses with `verification.status === 'verified'` are trusted.
3. **Just-In-Time (JIT) Provisioning**:
   - `syncClerkUser` provisions or updates the internal `users` record using an atomic `INSERT ... ON CONFLICT (clerk_id) DO UPDATE`.
   - Normalization: emails are lowercased and trimmed.
   - Collision protection: if an email is already associated with another `clerk_id`, the API returns a `409 Conflict`.
4. **Role-Based Access Control (RBAC)**:
   - **`admin`**: Full platform authority. Can create, read, update, and delete any service, trigger builds, and view system logs. Granted automatically to verified users whose emails match `ADMIN_EMAILS`.
   - **`developer`**: Can view catalog, create new services, and edit or delete services they own (`services.owner_id === users.id`).
   - **`viewer`**: Read-only access across the catalog and platform metrics. Cannot create, edit, or delete services.
   - **No Automatic Demotion**: Once a user is an `admin` or `developer`, subsequent logins do not demote them to `viewer`, preventing race conditions and administrative lockouts.
