# Social Spy Automation — container image (Docker mode, Master Plan §15). Native mode needs no Docker.
# One Node image runs api / worker / scheduler / migrate (selected by the compose `command`).
# The web UI is built in a separate stage and served by nginx (same-origin /api reverse proxy).

FROM node:22-alpine AS deps
WORKDIR /app
COPY . .
# postinstall runs `prisma generate`
RUN npm ci --no-audit --no-fund

FROM deps AS web-build
RUN npm run build -w @sss/web

FROM node:22-alpine AS app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app /app
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
# Default: API. Compose overrides for worker/scheduler/migrate.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/api/src/main.ts"]

FROM nginx:stable-alpine AS web
COPY infrastructure/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
