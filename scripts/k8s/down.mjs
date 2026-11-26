import { execFileSync } from 'child_process';

const args = process.argv.slice(2);
if (!args.includes('--yes')) {
  console.error('Refusing to delete kind cluster without --yes flag.');
  console.error('Usage: pnpm k8s:down --yes');
  process.exit(1);
}

execFileSync('kind', ['delete', 'cluster', '--name', 'forgeflow'], { stdio: 'inherit' });
