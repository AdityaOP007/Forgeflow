const GITHUB_TOKEN_REGEX =
  /\b(ghs_[A-Za-z0-9_]{30,}|ghp_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const PEM_BLOCK_REGEX = /-----BEGIN [A-Z0-9 _-]+-----[\s\S]*?-----END [A-Z0-9 _-]+-----/g;

/**
 * Removes secrets from strings including:
 * - GitHub App and PAT tokens (ghs_*, ghp_*, github_pat_*)
 * - Authorization Bearer tokens ("Bearer <token>")
 * - PEM format private keys (-----BEGIN ... ----- ... -----END ... -----)
 */
export function redactSecrets(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(PEM_BLOCK_REGEX, '[REDACTED_PRIVATE_KEY]')
    .replace(GITHUB_TOKEN_REGEX, '[REDACTED_TOKEN]')
    .replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED_TOKEN]');
}
