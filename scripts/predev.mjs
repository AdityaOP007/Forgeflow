import { execSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';

// 1. Check if Docker daemon is running
try {
  execSync('docker info', { stdio: 'ignore' });
} catch {
  console.error(
    '\n\x1b[31m[ForgeFlow] Error: Docker is not running.\x1b[0m\nPlease start Docker Desktop or the Docker daemon and run `pnpm dev` again.\n'
  );
  process.exit(1);
}

// 2. Start PostgreSQL container and wait until healthy
try {
  console.log('\x1b[36m[ForgeFlow] Starting PostgreSQL container...\x1b[0m');
  execSync('docker compose up -d --wait postgres', { stdio: 'inherit' });
} catch {
  console.error(
    '\n\x1b[31m[ForgeFlow] Error: Failed to start PostgreSQL container with docker compose.\x1b[0m\n'
  );
  process.exit(1);
}
