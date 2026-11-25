# GitHub App Setup Guide

ForgeFlow uses a **GitHub App** installed on a **GitHub Organization** to create service repositories and commit generated scaffold files using short-lived installation tokens.

> **Important:** Personal GitHub accounts are not supported because GitHub App installation tokens cannot create repositories under personal accounts.

## Step 1: Create a GitHub Organization

1. Sign in to GitHub and click **+** in the top-right corner -> **New organization** (or use an existing organization you own).
2. Choose the **Free** plan and complete the organization setup.
3. Note your organization slug (for example, `my-forgeflow-org`). This will be `GITHUB_ORG`.

## Step 2: Create the GitHub App Under the Organization

1. Open your organization page on GitHub and go to **Settings** -> **Developer settings** -> **GitHub Apps** -> **New GitHub App**.
2. Fill in the basic details:
   - **GitHub App name:** e.g. `forgeflow-local-dev` (must be globally unique on GitHub)
   - **Homepage URL:** `http://localhost:5173`
3. **Webhook:**
   - Uncheck **Active** (ForgeFlow does not receive webhooks in Phase 2).
4. **Repository permissions:**
   - **Administration:** `Read and write` (required to create repositories)
   - **Contents:** `Read and write` (required to commit scaffold files)
   - **Workflows:** `Read and write` (required to commit `.github/workflows/ci.yml`)
   - **Actions:** `Read-only`
   - **Metadata:** `Read-only` (selected automatically)
5. **Where can this GitHub App be installed?**
   - Select **Only on this account**.
6. Click **Create GitHub App**.

## Step 3: Note the App ID and Generate a Private Key

1. On the App's **General** settings page, copy the **App ID** (numeric). This is `GITHUB_APP_ID`.
2. Scroll down to **Private keys** and click **Generate a private key**.
3. Save the downloaded `.pem` file into the `./secrets/` directory in your ForgeFlow repository root, for example:
   ```bash
   mkdir -p secrets
   mv ~/Downloads/forgeflow-local-dev.*.private-key.pem ./secrets/github-app.pem
   chmod 600 ./secrets/github-app.pem
   ```
   _(The `./secrets/` directory and `*.pem` files are ignored by `.gitignore` and will never be committed.)_

## Step 4: Install the App on Your Organization

1. In the left sidebar of your GitHub App settings, click **Install App**.
2. Click **Install** next to your organization.
3. Select **All repositories** (newly created repositories must be covered automatically by the installation).
4. Click **Install**.
5. Look at the browser URL after installation, e.g.:
   `https://github.com/organizations/<org>/settings/installations/12345678`
   The number at the end (`12345678`) is your `GITHUB_APP_INSTALLATION_ID`.

## Step 5: Configure Environment Variables

Add the following variables to your `.env` and `apps/api/.env` files:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_ORG=your-github-org
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app.pem
```

## Step 6: Verify Connectivity

Run the read-only permission check and end-to-end smoke test:

```bash
pnpm --filter @forgeflow/api github:check
pnpm --filter @forgeflow/api github:smoke
```
