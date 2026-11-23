import dotenv from 'dotenv';
dotenv.config();

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
