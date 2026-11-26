import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Apply committed migrations (`prisma migrate deploy`) against `url`.
 * Runs the local Prisma CLI through Node so it works the same on Windows and macOS.
 */
export async function migrateDeploy(url: string): Promise<void> {
  const cli = join(PKG_DIR, '..', '..', 'node_modules', 'prisma', 'build', 'index.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'migrate', 'deploy'], {
      cwd: PKG_DIR,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`prisma migrate deploy failed (${code}):\n${out}`))));
  });
}
