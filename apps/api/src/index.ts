import dotenv from 'dotenv';
dotenv.config();

import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { clerkAuthVerifier } from './middleware/auth.js';

const env = loadEnv();
const app = createApp({
  auth: clerkAuthVerifier,
  webOrigin: env.WEB_ORIGIN,
});

app.listen(env.PORT, () => {
  console.log(`ForgeFlow API listening on port ${env.PORT}`);
});
