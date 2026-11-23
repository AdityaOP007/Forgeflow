# ForgeFlow

ForgeFlow is an Internal Developer Platform (IDP) web portal that empowers developers to scaffold microservices from standardized templates. It automates repository provisioning, CI/CD pipeline generation, deployment, and service monitoring through a single unified interface.

## Current Goal

> **Phase 0 (Prepare)**: Establish the monorepo foundation and workspace skeleton so that a basic React frontend and a basic Node.js API start locally and communicate cleanly.

## Prerequisites

- **Node.js**: v20+ (`node -v`)
- **pnpm**: v9+ (`pnpm -v`)
- **Docker**: For containerized workflows in upcoming phases (`docker -v`)
- **Git**: Version control (`git --version`)

## Monorepo Structure

```text
forgeflow/
|-- apps/
|   |-- web/                 # React + TypeScript (Vite + Tailwind CSS)
|   `-- api/                 # Node.js + TypeScript backend (Express)
|-- packages/
|   |-- shared-types/        # Shared TypeScript definitions (HealthResponse)
|   `-- ui/                  # Reusable UI component library (Phase 1+)
|-- templates/
|   |-- node-service/        # Node.js service template (placeholder)
|   `-- fastapi-service/     # FastAPI service template (placeholder)
|-- infrastructure/
|   |-- docker/              # Docker assets (placeholder)
|   |-- kubernetes/          # Kubernetes manifests (placeholder)
|   |-- helm/                # Helm charts (placeholder)
|   `-- terraform/           # Terraform modules (placeholder)
|-- .github/workflows/
|   `-- ci.yml               # GitHub Actions CI workflow (lint, typecheck, build)
|-- docs/
|   |-- architecture.md      # High-level system architecture stub
|   |-- threat-model.md      # Security threat model stub
|   `-- runbooks/            # Operational runbooks (placeholder)
|-- docker-compose.yml       # Local development services (PostgreSQL placeholder)
|-- package.json             # Root monorepo workspace scripts
|-- pnpm-workspace.yaml      # pnpm workspace configuration
`-- README.md                # Project documentation
```

## Getting Started Locally

### 1. Install Dependencies

Install all monorepo dependencies across workspaces:

```bash
pnpm install
```

### 2. Run Both Apps in Development

Start both the backend API and frontend portal concurrently:

```bash
pnpm dev
```

- **Frontend Portal**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:4000](http://localhost:4000)
- **API Health Endpoint**: [http://localhost:4000/health](http://localhost:4000/health)

### 3. Verification Commands

Run workspace-wide linting, type-checking, and production builds:

```bash
# Code quality check
pnpm lint

# TypeScript static analysis across all workspaces
pnpm typecheck

# Build all packages and applications
pnpm build
```

# Forgeflow
