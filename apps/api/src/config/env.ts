import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  LOCAL_USER_EMAIL: z.string().email().default('admin@forgeflow.local'),
});

export type Env = z.infer<typeof envSchema>;

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
