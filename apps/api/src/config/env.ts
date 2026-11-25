import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../');

const optionalNonEmptyString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  LOCAL_USER_EMAIL: z.string().email().default('admin@forgeflow.local'),
  WORKER_POLL_MS: z.coerce.number().default(1000),
  WORKER_STALE_MS: z.coerce.number().default(120000),
  GITHUB_APP_ID: optionalNonEmptyString,
  GITHUB_APP_INSTALLATION_ID: optionalNonEmptyString,
  GITHUB_ORG: optionalNonEmptyString,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalNonEmptyString,
});

export type Env = z.infer<typeof envSchema>;

export interface GitHubConfig {
  appId: string;
  installationId: string;
  org: string;
  privateKeyPath: string;
  privateKey: string;
}

export interface GitHubConfigResult {
  configured: boolean;
  config: GitHubConfig | null;
  error?: string;
}

let _env: Env | null = null;

export function resetEnv(): void {
  _env = null;
}

export function loadEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  // Hard safety guard: local auth mode must never run in production
  if (result.data.NODE_ENV === 'production') {
    throw new Error('Local auth cannot be used in production');
  }

  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) return loadEnv();
  return _env;
}

function resolveKeyPath(rawPath: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(REPO_ROOT, rawPath);
}

export function isValidPem(content: string): boolean {
  return (
    content.includes('-----BEGIN') &&
    content.includes('PRIVATE KEY-----') &&
    content.includes('-----END')
  );
}

/**
 * Inspect optional GitHub App environment configuration without crashing if absent.
 * Validates private key existence, readability, and PEM format when path is set.
 * Never logs or returns secret values.
 */
export function getGitHubConfig(envOverride?: Partial<Env>): GitHubConfigResult {
  const env = envOverride ? { ...getEnv(), ...envOverride } : getEnv();
  const missing: string[] = [];
  if (!env.GITHUB_APP_ID) missing.push('GITHUB_APP_ID');
  if (!env.GITHUB_APP_INSTALLATION_ID) missing.push('GITHUB_APP_INSTALLATION_ID');
  if (!env.GITHUB_ORG) missing.push('GITHUB_ORG');
  if (!env.GITHUB_APP_PRIVATE_KEY_PATH) missing.push('GITHUB_APP_PRIVATE_KEY_PATH');

  if (missing.length > 0) {
    return {
      configured: false,
      config: null,
      error: `GitHub App environment variables are not configured (missing: ${missing.join(', ')})`,
    };
  }

  if (!/^\d+$/.test(env.GITHUB_APP_ID!)) {
    return {
      configured: false,
      config: null,
      error: 'GITHUB_APP_ID must be a numeric ID',
    };
  }

  if (!/^\d+$/.test(env.GITHUB_APP_INSTALLATION_ID!)) {
    return {
      configured: false,
      config: null,
      error: 'GITHUB_APP_INSTALLATION_ID must be a numeric ID',
    };
  }

  const resolvedPath = resolveKeyPath(env.GITHUB_APP_PRIVATE_KEY_PATH!);
  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK);
  } catch {
    return {
      configured: false,
      config: null,
      error: `GITHUB_APP_PRIVATE_KEY_PATH does not exist or is not readable at '${resolvedPath}'`,
    };
  }

  let privateKey: string;
  try {
    privateKey = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    return {
      configured: false,
      config: null,
      error: `Failed to read GitHub App private key file at '${resolvedPath}'`,
    };
  }

  if (!isValidPem(privateKey)) {
    return {
      configured: false,
      config: null,
      error: `GitHub App private key file at '${resolvedPath}' does not contain a valid PEM private key`,
    };
  }

  return {
    configured: true,
    config: {
      appId: env.GITHUB_APP_ID!,
      installationId: env.GITHUB_APP_INSTALLATION_ID!,
      org: env.GITHUB_ORG!,
      privateKeyPath: resolvedPath,
      privateKey,
    },
  };
}
