# ForgeFlow

ForgeFlow is an Internal Developer Platform (IDP) web portal that empowers engineering teams to scaffold, manage, and monitor microservices from standardized templates. It automates repository provisioning, CI/CD pipeline generation, deployment, and service monitoring through a single unified interface.

## Current Status

> **Phase 2 (Service Scaffolding, Workflow Engine & GitHub App Integration)**: Asynchronous workflow queue and worker, template rendering engine (`python-fastapi`), GitHub App integration (`createRepository` + Git Data API commit), 5-step service scaffolding wizard, real-time workflow progress and log streaming, and retry/cancellation controls.
>
> **Phase 1 (Foundation and Service Catalog)**: PostgreSQL persistence with Drizzle ORM, local admin mode with server-side RBAC (`admin`, `developer`, `viewer`), service catalog CRUD, architecture templates, dashboard overview, and comprehensive API testing.
>
> **Note on Authentication**: The platform currently runs in **local development mode** as a single built-in local admin user (`admin@forgeflow.local`, role: `admin`), bypassing sign-in requirements. Full Clerk authentication has been safely preserved in git tag `phase-1-clerk` and will be reintroduced in a later phase alongside an enterprise SSO provider option.

---

## Prerequisites

- **Node.js**: v20+ (`node -v`)
- **pnpm**: v9+ (`pnpm -v`)
- **Docker**: For local PostgreSQL database (`docker -v` and `docker compose version`)
- **Git**: Version control (`git --version`)

---

## Quick Start & Running Locally

Get the complete ForgeFlow platform running with a single command:

### 1. Clone the Repository

```bash
git clone <repository-url>
cd Forgeflow
```

### 2. Copy Environment Files

```bash
# Root monorepo environment
cp .env.example .env

# API service environment
cp apps/api/.env.example apps/api/.env

# Web client environment
cp apps/web/.env.example apps/web/.env
```

> **Environment Precedence**: Process environment variables take precedence over `apps/api/.env` in both the API (`apps/api/src/index.ts`) and the worker (`apps/api/src/worker/index.ts`), because `dotenv.config` is called without `override: true`. This allows operators, CI pipelines, and test runs to override settings (such as `DEPLOY_TIMEOUT_SECONDS`, `RECONCILE_INTERVAL_MS`, `GITHUB_WEBHOOK_SECRET`, or credentials) per process without modifying `apps/api/.env`.

### 3. Install Dependencies

```bash
pnpm install
```

### 4. Start Development (`pnpm dev`)

```bash
pnpm dev
```

`pnpm dev` automatically performs all required setup steps in order:

1. **Predev Step**: Verifies Docker is running and starts PostgreSQL (`docker compose up -d --wait postgres`).
2. **Migrations & Seed**: Runs schema migrations (`pnpm db:migrate`) and seeds reference service templates (`pnpm db:seed`).
3. **Application Servers**: Starts the backend API (`http://127.0.0.1:4000`), the background workflow worker (`dev:worker`), and the Vite web portal (`http://localhost:5173`) in parallel.
4. **Browser Launch**: Automatically opens your browser directly to `/dashboard`.

> **Note on Individual Scripts**:
> You can still run individual lifecycle commands as needed:
>
> - `pnpm db:migrate` — Run pending database migrations
> - `pnpm db:seed` — Idempotently seed reference templates
> - `pnpm --filter @forgeflow/api dev` — Run API server only
> - `pnpm --filter @forgeflow/api dev:worker` — Run background workflow worker only
> - `pnpm --filter @forgeflow/web dev` — Run Web portal only
> - `pnpm --filter @forgeflow/api github:check` — Verify GitHub App configuration and installation permissions
> - `pnpm --filter @forgeflow/api github:smoke` — Run end-to-end GitHub App repository create/commit/delete smoke test
> - `pnpm --filter @forgeflow/api verify:template` — Render and test `templates/fastapi-service` inside `python:3.12-slim` and Docker Compose

### 5. Phase 2 GitHub App Setup & Environment Variables

To enable real GitHub repository scaffolding (`POST /api/services/scaffold` and the 5-step Create Service wizard):

1. Follow [`docs/github-app-setup.md`](docs/github-app-setup.md) to create a GitHub App, install it on your organization, and save the `.pem` private key under `./secrets/` (gitignored).
2. Configure the Phase 2 variables in `apps/api/.env`:

```bash
GITHUB_APP_ID=<your-app-id>
GITHUB_APP_INSTALLATION_ID=<your-installation-id>
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app.pem
GITHUB_ORG=<your-github-org-login>
WORKER_POLL_MS=1000
```

3. Verify connectivity with `pnpm --filter @forgeflow/api github:check`.

---

## Monorepo Architecture

```text
forgeflow/
|-- apps/
|   |-- web/                 # React 18 + Vite + Tailwind CSS + TanStack Query
|   `-- api/                 # Express + TypeScript + Drizzle ORM + Local Auth
|-- packages/
|   |-- shared-types/        # Shared Zod validation schemas & TypeScript contracts
|   `-- ui/                  # Reusable UI component library (Phase 1+)
|-- templates/
|   |-- node-service/        # Node.js Express service template
|   `-- fastapi-service/     # Python FastAPI service template
|-- infrastructure/
|   |-- docker/              # Docker assets
|   |-- kubernetes/          # Kubernetes manifests (Phase 2+)
|   |-- helm/                # Helm charts (Phase 2+)
|   `-- terraform/           # Terraform modules (Phase 2+)
|-- .github/workflows/
|   `-- ci.yml               # GitHub Actions CI workflow (lint, prettier, typecheck, test, build)
|-- docs/
|   |-- architecture.md      # Detailed system architecture & schema documentation
|   |-- threat-model.md      # Security threat model & mitigation strategies
|   `-- runbooks/            # Operational runbooks
|-- docker-compose.yml       # Local PostgreSQL database services
|-- package.json             # Root monorepo workspace configuration
|-- pnpm-workspace.yaml      # pnpm workspace definition
`-- README.md                # Project documentation
```

---

## Local Development Mode & Role Testing

In local development mode:

- The application runs as a single built-in local admin user (`name: "Local Admin"`, `email: "admin@forgeflow.local"`, `role: "admin"`).
- Incoming `Authorization` headers are ignored.
- The API explicitly binds to `127.0.0.1` and fails immediately if `NODE_ENV === 'production'`.
- The database schema retains the `clerk_id` column (`users.clerk_id = 'local-admin'`) as an external identity placeholder for future enterprise auth integrations.
- There is **no client-side role switcher** in the UI. If a developer wants to test `viewer` or `developer` permissions, they can change the role in the database directly:

```sql
-- Switch local user to viewer
UPDATE users SET role = 'viewer' WHERE clerk_id = 'local-admin';

-- Restore local user to admin
UPDATE users SET role = 'admin' WHERE clerk_id = 'local-admin';
```

---

## Verification & Testing

Run the full verification suite across all workspaces:

```bash
# Code quality and formatting checks
pnpm lint

# Strict TypeScript type-checking across all workspaces
pnpm typecheck

# Automated test suite (Vitest + Supertest against forgeflow_test)
pnpm test

# Production build across packages and applications
pnpm build
```
