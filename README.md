# ForgeFlow

ForgeFlow is an Internal Developer Platform (IDP) web portal that empowers engineering teams to scaffold, manage, and monitor microservices from standardized templates. It automates repository provisioning, CI/CD pipeline generation, deployment, and service monitoring through a single unified interface.

## Current Status

> **Phase 1 (Foundation and Service Catalog)**: Complete foundation featuring PostgreSQL persistence with Drizzle ORM, Clerk authentication, server-side RBAC (`admin`, `developer`, `viewer`), service catalog CRUD, architecture templates, dashboard overview, and end-to-end API testing.

---

## Prerequisites

- **Node.js**: v20+ (`node -v`)
- **pnpm**: v9+ (`pnpm -v`)
- **Docker**: For local PostgreSQL database (`docker -v` and `docker compose version`)
- **Git**: Version control (`git --version`)

---

## Monorepo Architecture

```text
forgeflow/
|-- apps/
|   |-- web/                 # React 18 + Vite + Tailwind CSS + Clerk React
|   `-- api/                 # Express + TypeScript + Drizzle ORM + Clerk Express
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

## Phase 1 Setup & Getting Started

### 1. Clerk Authentication Setup

1. Create a free account and application at [Clerk](https://clerk.com).
2. Enable **Email / Password** or **Google** authentication in your Clerk dashboard.
3. Ensure **Email Verification** is required so primary email addresses have `status: "verified"`.
4. Copy your **Publishable Key** (`pk_test_...`) and **Secret Key** (`sk_test_...`).

### 2. Environment Configuration

Copy the example environment files:

```bash
# Root monorepo environment
cp .env.example .env

# API service environment
cp apps/api/.env.example apps/api/.env

# Web client environment
cp apps/web/.env.example apps/web/.env
```

Configure your keys in the `.env` files:

- **`apps/api/.env`**:
  ```env
  PORT=4000
  NODE_ENV=development
  WEB_ORIGIN=http://localhost:5173
  DATABASE_URL=postgresql://forgeflow:forgeflow_password@localhost:5432/forgeflow
  TEST_DATABASE_URL=postgresql://forgeflow:forgeflow_password@localhost:5432/forgeflow_test
  CLERK_SECRET_KEY=sk_test_your_clerk_secret_key
  CLERK_PUBLISHABLE_KEY=pk_test_your_clerk_publishable_key
  ADMIN_EMAILS=your-admin-email@example.com
  ```
- **`apps/web/.env`**:
  ```env
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_your_clerk_publishable_key
  ```

### 3. Start Local Infrastructure

Start the PostgreSQL service using Docker Compose:

```bash
docker compose up -d
```

This provisions the `forgeflow-postgres` container on port `5432` with both the `forgeflow` (development) and `forgeflow_test` (test) databases.

### 4. Database Migrations & Seeding

Run Drizzle migrations to create the 6 platform tables:

```bash
pnpm db:migrate
```

Seed the platform with starter templates:

```bash
pnpm db:seed
```

> **Note on Database Reset**:
> `pnpm db:reset` drops and recreates public schema tables, runs migrations, and applies seeds. It includes a strict safety guard that refuses to execute when `NODE_ENV=production`.

### 5. Start Development Servers

Run both the API backend and React frontend concurrently:

```bash
pnpm dev
```

- **Frontend Portal**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:4000](http://localhost:4000)
- **Health Check**: [http://localhost:4000/health](http://localhost:4000/health)
- **Database Readiness**: [http://localhost:4000/health/ready](http://localhost:4000/health/ready)

---

## Identity & Role Model (`clerk_id`)

ForgeFlow uses Clerk for identity and token issuance, paired with internal Just-In-Time (JIT) provisioning:

- Every record in the `users` table contains a unique `clerk_id` referencing the Clerk user identifier (e.g., `user_2...`).
- When an authenticated request arrives at the API, the `clerkAuthVerifier` validates the bearer token via `@clerk/express`, fetches the user profile using `clerkClient.users.getUser(userId)`, and synchronizes the user via `syncClerkUser`.
- The user's primary email address is checked:
  - If the email is verified and present in `ADMIN_EMAILS`, the user is granted the `admin` role.
  - Otherwise, new accounts receive the `viewer` role.
  - Existing `developer` or `admin` roles are preserved (no automatic demotion).
- All platform resources (services, audit logs) link to the internal UUID `users.id`, ensuring database integrity while remaining decoupled from external auth providers.

---

## Verification & Testing

Run the full verification suite across all workspaces:

```bash
# Code quality and formatting checks
pnpm lint
pnpm format:check

# Strict TypeScript type-checking across all workspaces
pnpm typecheck

# Automated test suite (Vitest + Supertest against forgeflow_test)
pnpm test

# Production build across packages and applications
pnpm build
```
