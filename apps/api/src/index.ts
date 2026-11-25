import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const envPath = path.join(repoRoot, 'apps/api/.env');
dotenv.config({ path: envPath, override: true });
console.log(`Loaded env from ${envPath}`);

import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { localUserAuthVerifier } from './middleware/auth.js';

const env = loadEnv();
const app = createApp({
  auth: localUserAuthVerifier,
  webOrigin: env.WEB_ORIGIN,
});

// Explicitly bind to 127.0.0.1 for local security
app.listen(env.PORT, '127.0.0.1', () => {
  console.log(`ForgeFlow API listening on http://127.0.0.1:${env.PORT}`);
});
