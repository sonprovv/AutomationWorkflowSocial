import { join } from 'node:path';
import { findRepoRoot, loadConfig } from '@sss/config';
import { createRuntime, JobService } from '@sss/services';
import { buildServer } from './server.ts';

const config = loadConfig();
const serveWeb = process.env.SERVE_WEB === 'true';
const webDist = serveWeb ? join(findRepoRoot(), 'apps', 'web', 'dist') : null;

const runtime = createRuntime(config);
// Inline mode runs jobs inside this process, so any job still QUEUED/RUNNING from an earlier run of the
// API can never finish: mark those FAILED/ORPHANED at startup (the user can retry them).
if (config.QUEUE_DRIVER === 'inline') {
  const orphans = await new JobService(runtime.ctx).reconcileOrphans(async () => false, new Date());
  if (orphans.length) console.warn(`[api] marked ${orphans.length} orphaned job(s) from a previous run as FAILED`);
}
const app = await buildServer({
  runtime,
  logger: {
    level: config.LOG_LEVEL,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-goog-api-key"]'], censor: '[REDACTED]' },
  },
  webDist,
});

const port = config.API_PORT;
try {
  await app.listen({ host: config.API_HOST, port });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') {
    app.log.error(`Port ${port} on ${config.API_HOST} is already in use. Set API_PORT (or APP_PORT for the start script) in .env to a free port.`);
  } else {
    app.log.error(err);
  }
  process.exit(1);
}
app.log.info(`API ready on http://${config.API_HOST}:${port}/api/v1 (docs: /api/docs, queue driver: ${config.QUEUE_DRIVER})`);

let closing = false;
// Graceful stop requests: OS signals, or an IPC message from the native supervisor (Windows cannot
// deliver catchable signals to child processes).
const onStop = (fn: () => void) => {
  process.on('SIGINT', fn);
  process.on('SIGTERM', fn);
  process.on('message', (m: unknown) => {
    if ((m as { type?: string })?.type === 'shutdown') fn();
  });
};
{
  const sig = 'stop request';
  onStop(async () => {
    if (closing) return;
    closing = true;
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
