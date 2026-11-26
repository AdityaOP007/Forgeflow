# GHCR Pull Credentials Setup

ForgeFlow scaffolds services whose GitHub Actions CI workflow builds and pushes container images to GitHub Container Registry (`ghcr.io/<owner>/<service>:<commit-sha>`). Because `forgeflow-aditya` repositories are private, the local Kubernetes cluster needs an `imagePullSecret` to pull those images.

> **Why a classic PAT is required:** GitHub Packages (`ghcr.io`) does not accept GitHub App installation tokens or fine-grained PATs for external `docker pull` / Kubernetes `imagePullSecret` authentication. Only a **classic Personal Access Token** with `read:packages` works outside GitHub Actions.

## 1. Create the Classic Token

1. Sign in to the GitHub account that has access to the `forgeflow-aditya` organization packages (for example, your organization owner or dedicated bot account).
2. Open: <https://github.com/settings/tokens/new?scopes=read:packages>
3. Set a descriptive note (e.g. `forgeflow-dev-ghcr-pull`).
4. Set **Expiration** to **90 days** (or shorter per your security policy).
5. Ensure **only** the `read:packages` scope is checked (do not grant `repo`, `write:packages`, or `admin:*`).
6. Click **Generate token** and copy the `ghp_...` value.

## 2. Configure `apps/api/.env`

Add the credentials to `apps/api/.env` (never commit this file):

```bash
GHCR_PULL_USERNAME=<github-username-that-owns-the-token>
GHCR_PULL_TOKEN=<ghp_token>
```

## 3. Security & Rotation

- **Privilege boundary:** Only the ForgeFlow **worker** process reads `GHCR_PULL_USERNAME` and `GHCR_PULL_TOKEN` to build the Kubernetes `ghcr-pull` `dockerconfigjson` secret inside the `forgeflow-dev` namespace. The Express API process never creates or reads Kubernetes secrets.
- **Rotation:** Before the 90-day expiry, generate a new `read:packages` classic token, update `GHCR_PULL_TOKEN` in `apps/api/.env`, and restart `pnpm dev` (the next deploy refreshes the `ghcr-pull` secret automatically).
