import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Tiny local HTTP server for contract tests (no network, no real provider).
 * Each route handler returns { status, body, headers }. Requests are recorded.
 */
export type FakeRoute = (req: { url: URL; method: string; headers: IncomingMessage['headers']; body: string }) =>
  | { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; delayMs?: number }
  | Promise<{ status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; delayMs?: number }>;

export interface FakeServer {
  baseUrl: string;
  requests: { method: string; url: URL; headers: IncomingMessage['headers'] }[];
  close(): Promise<void>;
}

export async function startFakeServer(routes: Record<string, FakeRoute>): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method ?? 'GET', url, headers: req.headers });
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'NoRoute', message: `no fake route ${url.pathname}` }));
      return;
    }
    const r = await route({ url, method: req.method ?? 'GET', headers: req.headers, body });
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    if (res.destroyed) return;
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
    res.end(r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body)));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

export const noSleep = async (): Promise<void> => {};
