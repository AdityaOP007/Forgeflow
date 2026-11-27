# Local GitHub Webhooks (Optional)

ForgeFlow's worker automatically polls GitHub Actions for CI status updates every `CI_SYNC_INTERVAL_MS` (default `60000` ms, or every `15000` ms while a CI run is in progress). **Polling works without webhooks**, so setting up a webhook is completely optional for local development.

If you want near-instant CI status updates via GitHub webhooks:

## 1. Generate a Webhook Secret

Generate a random 32-byte hex secret (never commit it or print it to logs):

```bash
openssl rand -hex 32
```

Add it to `apps/api/.env`:

```env
GITHUB_WEBHOOK_SECRET=<your-generated-secret>
```

## 2. Expose Local API via a Tunnel

Point a tunnel (such as `smee.io`, `cloudflared`, or `ngrok`) at `http://127.0.0.1:4000/api/webhooks/github`.

For example, with `smee-client`:

```bash
npx smee-client --url https://smee.io/<your-channel> --target http://127.0.0.1:4000/api/webhooks/github
```

## 3. Configure the GitHub App Webhook

1. Open your GitHub App settings (**Developer settings → GitHub Apps → your app**).
2. Under **Webhook**:
   - Check **Active**.
   - Set **Webhook URL** to your tunnel URL (for `smee.io`, `https://smee.io/<your-channel>`).
   - Set **Webhook secret** to the `GITHUB_WEBHOOK_SECRET` value from `apps/api/.env`.
3. Under **Subscribe to events**, enable **Workflow run** (and optionally **Workflow job**).
4. Save changes and restart the ForgeFlow API (`pnpm dev`).

## Security Notes

- Every `POST /api/webhooks/github` request must be `application/json` under `256kb`, signed with `X-Hub-Signature-256`, and verified with `crypto.timingSafeEqual` before any database access.
- Deliveries are deduplicated by `X-GitHub-Delivery` in `webhook_deliveries`.
- Stale out-of-order `workflow_run` events (older `updated_at`) never overwrite newer state.

