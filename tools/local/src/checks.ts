import { createServer } from 'node:net';
import { Redis } from 'ioredis';

/** Is host:port free to bind? */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** Ping Redis with a short timeout; never throws. */
export async function redisReachable(url: string, timeoutMs = 1500): Promise<{ ok: boolean; error?: string; version?: string }> {
  const r = new Redis(url, { lazyConnect: true, connectTimeout: timeoutMs, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
  r.on('error', () => {});
  try {
    await r.connect();
    const info = await r.info('server');
    const version = /redis_version:([^\r\n]+)/.exec(info)?.[1];
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    r.disconnect();
  }
}

export function nodeVersionOk(): { ok: boolean; version: string } {
  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  return { ok: maj > 22 || (maj === 22 && min >= 12), version: process.versions.node };
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
