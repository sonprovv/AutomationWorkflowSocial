import { existsSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { redactUrl } from '@sss/collector-core';
import { databaseMetrics, HttpMetrics, type Runtime } from '@sss/services';
import { AppError, toApiError } from '@sss/shared';
import { registerRoutes } from './routes.ts';

export interface ServerOptions {
  runtime: Runtime;
  logger?: boolean | object;
  /** Serve the built web UI (apps/web/dist) from the same origin (native mode). */
  webDist?: string | null;
}

export async function buildServer(o: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: o.logger ?? false,
    genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].slice(0, 64) : randomUUID()),
    bodyLimit: 1_000_000,
  }).withTypeProvider<ZodTypeProvider>();

  app.addHook('onClose', async () => o.runtime.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const metrics = new HttpMetrics();
  const token = o.runtime.ctx.config.API_TOKEN;
  const tokenBuf = token ? Buffer.from(`Bearer ${token}`) : null;
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    // The UI loads only its own bundle; images may come from provider CDNs (avatars) over https.
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    // Remote exposure (API_HOST not loopback) requires a bearer token on every API call except liveness.
    if (tokenBuf && req.url.startsWith('/api/') && !req.url.startsWith('/api/v1/health/live')) {
      const given = Buffer.from(String(req.headers.authorization ?? ''));
      if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
        return reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Missing or invalid API token', requestId: req.id } });
      }
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    metrics.observe(req.method, req.routeOptions.url ?? 'unmatched', reply.statusCode, reply.elapsedTime / 1000);
  });
  app.get('/api/v1/metrics', { schema: { tags: ['health'], description: 'Prometheus text metrics (HTTP, jobs, queue age, posts, provider usage/cost/reservations, collection runs, scheduler).' } }, async (_req, reply) => {
    const lines = [...metrics.render(), ...(await databaseMetrics(o.runtime.ctx))];
    return reply.header('content-type', 'text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError || (err as { validation?: unknown }).validation || (err as { code?: string }).code === 'FST_ERR_VALIDATION') {
      const issues = err instanceof ZodError ? err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) : (err as { validation?: unknown }).validation;
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: { issues }, requestId: req.id } });
    }
    if ((err as { statusCode?: number }).statusCode === 415 || (err as { code?: string }).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send({ error: { code: 'INVALID_INPUT', message: 'Unsupported content type', requestId: req.id } });
    }
    if ((err as { code?: string }).code === 'FST_ERR_CTP_INVALID_JSON_BODY' || (err as { code?: string }).code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send({ error: { code: 'INVALID_INPUT', message: 'Malformed JSON body', requestId: req.id } });
    }
    const { status, body } = toApiError(err, req.id);
    if (status >= 500) req.log.error({ err: { message: (err as Error).message, code: (err as AppError).code }, url: redactUrl(req.url) }, 'request failed');
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url.split('?')[0]} not found`, requestId: req.id } });
    }
    if (o.webDist && req.method === 'GET') return reply.sendFile('index.html'); // SPA fallback
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: req.id } });
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Social Spy Automation API', version: '0.1.0', description: 'Local REST API (Master Plan §11). Long-running operations return 202 + job_id.' },
      servers: [{ url: '/' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  await app.register(async (api) => registerRoutes(api.withTypeProvider<ZodTypeProvider>(), o.runtime), { prefix: '/api/v1' });

  if (o.webDist && existsSync(o.webDist)) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: o.webDist, prefix: '/', wildcard: false });
  }
  return app;
}

export { AppError };
