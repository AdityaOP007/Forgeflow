const GITHUB_TOKEN_REGEX =
  /\b(ghs_[A-Za-z0-9_]{30,}|ghp_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g;
const CLERK_KEY_REGEX =
  /\b(sk_(?:test|live)_[A-Za-z0-9]{10,}|pk_(?:test|live)_[A-Za-z0-9]{10,})\b/g;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const PEM_BLOCK_REGEX = /-----BEGIN [A-Z0-9 _-]+-----[\s\S]*?-----END [A-Z0-9 _-]+-----/g;
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?\b/g;
const KUBECONFIG_FIELD_REGEX =
  /\b(token|client-key-data|certificate-authority-data)\s*:\s*["']?[^\s"'\n]+["']?/gi;
const DOCKERCONFIG_AUTH_REGEX = /"auth"\s*:\s*"[^"]+"/gi;
const PASSWORD_KV_REGEX = /(\bpassword\s*=\s*)([^\s&"']+)/gi;
const URL_PASSWORD_REGEX = /:([^:@\s/]{3,})@/g;

/**
 * Removes secrets from strings including:
 * - GitHub App and PAT tokens (ghs_*, ghp_*, github_pat_*)
 * - Authorization Bearer tokens ("Bearer <token>")
 * - PEM format private keys (-----BEGIN ... ----- ... -----END ... -----)
 * - JWT-like strings (eyJ...)
 * - Kubeconfig secret fields (token, client-key-data, certificate-authority-data)
 * - Dockerconfigjson auth values ("auth": "...")
 * - Password query/env/URL patterns (password=..., :password@)
 */
export function redactSecrets(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(PEM_BLOCK_REGEX, '[REDACTED_PRIVATE_KEY]')
    .replace(GITHUB_TOKEN_REGEX, '[REDACTED_TOKEN]')
    .replace(CLERK_KEY_REGEX, '[REDACTED_CLERK_KEY]')
    .replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED_TOKEN]')
    .replace(JWT_REGEX, '[REDACTED_JWT]')
    .replace(KUBECONFIG_FIELD_REGEX, '$1: [REDACTED]')
    .replace(DOCKERCONFIG_AUTH_REGEX, '"auth": "[REDACTED]"')
    .replace(PASSWORD_KV_REGEX, '$1[REDACTED]')
    .replace(URL_PASSWORD_REGEX, ':[REDACTED]@');
}
