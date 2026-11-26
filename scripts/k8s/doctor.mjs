import { execFileSync } from 'child_process';
import net from 'net';
import fs from 'fs';

const FEDORA_INSTALL_HINTS = {
  docker:
    'sudo dnf install -y dnf-plugins-core && sudo dnf install -y docker-ce docker-ce-cli containerd.io && sudo systemctl enable --now docker',
  kind: 'curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-amd64 && chmod +x ./kind && sudo mv ./kind /usr/local/bin/kind',
  kubectl: 'sudo dnf install -y kubernetes-client',
  helm: 'sudo dnf install -y helm',
};

function runCmd(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  let missing = false;
  console.log('=== ForgeFlow K8s Doctor ===');

  // 1. Docker daemon
  try {
    const ver = runCmd('docker', ['version', '--format', '{{.Server.Version}}']);
    console.log(`PASS docker daemon: v${ver}`);
  } catch {
    console.error('FAIL docker daemon is not running or not installed.');
    console.error(`  Fedora install: ${FEDORA_INSTALL_HINTS.docker}`);
    missing = true;
  }

  // 2. kind
  try {
    const ver = runCmd('kind', ['version']);
    console.log(`PASS kind: ${ver}`);
  } catch {
    console.error('FAIL kind is not installed.');
    console.error(`  Fedora install: ${FEDORA_INSTALL_HINTS.kind}`);
    missing = true;
  }

  // 3. kubectl
  try {
    const ver = runCmd('kubectl', ['version', '--client', '--output=yaml']);
    const gitVersion = ver.match(/gitVersion:\s*(\S+)/)?.[1] || ver.split('\n')[0];
    console.log(`PASS kubectl: ${gitVersion}`);
  } catch {
    console.error('FAIL kubectl is not installed.');
    console.error(`  Fedora install: ${FEDORA_INSTALL_HINTS.kubectl}`);
    missing = true;
  }

  // 4. helm
  try {
    const ver = runCmd('helm', ['version', '--short']);
    const majorMatch = ver.match(/v?(\d+)\./);
    const major = majorMatch ? Number(majorMatch[1]) : NaN;
    console.log(`PASS helm: ${ver} (major: ${Number.isFinite(major) ? major : 'unknown'})`);
    if (major !== 3 && major !== 4) {
      console.warn(`WARN Helm major version ${major} is not 3 or 4.`);
    }
  } catch {
    console.error('FAIL helm is not installed.');
    console.error(`  Fedora install: ${FEDORA_INSTALL_HINTS.helm}`);
    missing = true;
  }

  // 5. Check host ports 30080-30089
  const busyPorts = [];
  for (let p = 30080; p <= 30089; p++) {
    if (await checkPortInUse(p)) {
      busyPorts.push(p);
    }
  }
  if (busyPorts.length > 0) {
    console.warn(`WARN host ports in use on 127.0.0.1: ${busyPorts.join(', ')}`);
  } else {
    console.log('PASS host ports 30080-30089 on 127.0.0.1 are free');
  }

  // 6. Check free disk space (>= 10 GB)
  try {
    const stats = fs.statfsSync(process.cwd());
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    if (freeGb < 10) {
      console.warn(`WARN free disk space is ${freeGb.toFixed(2)} GB (recommended >= 10 GB)`);
    } else {
      console.log(`PASS free disk space: ${freeGb.toFixed(2)} GB`);
    }
  } catch (err) {
    console.warn(
      `WARN could not check disk space: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (missing) {
    process.exit(1);
  }
}

main();
