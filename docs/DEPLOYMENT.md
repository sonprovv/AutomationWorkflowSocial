# Deployment and local run

## 1. Native mode (default; no Docker)

**Requirements**
- Node.js 22 LTS.
- Optional: a Redis-compatible server, needed for the worker and the scheduler.
  - Windows: `winget install Memurai.MemuraiDeveloper`
  - macOS: `brew install redis && brew services start redis`

| | Windows | macOS |
|---|---|---|
| Start | double-click `start.bat` | `./start.command` (first time: `chmod +x start.command stop.command`) |
| Stop | `stop.bat` or Ctrl+C in the start window | `./stop.command` or Ctrl+C |
| Diagnose | `scripts\doctor.cmd` | `./scripts/doctor.sh` |

**What `start` does**
1. Checks Node and creates `.env` from `.env.example` if it is missing.
2. Checks that `APP_PORT` is free. It never kills another program. If the port is busy, change `APP_PORT` in `.env`.
3. Starts the embedded PostgreSQL. Data is kept in `.data/postgres`, which is git-ignored.
4. Applies migrations and seeds providers and policies.
5. Starts the services:
   - If Redis is reachable: api, worker and scheduler.
   - Otherwise: the api only, in **inline mode**, where jobs run inside the API process and schedules are disabled.
6. Builds the web UI on first run, waits for `/api/v1/health/ready`, prints the URL and opens the browser.

`stop` shuts everything down gracefully and **keeps all data**. To reset completely, stop the app and then delete `.data/`. This deletes all collected data.

**Settings in `.env`**
- `APP_PORT`: web and API port (default 18966).
- `EMBEDDED_PG_PORT`: embedded database port (default 18968).
- `DATABASE_URL`: set this to use your own PostgreSQL instead of the embedded one.
- `REDIS_URL`
- `OPEN_BROWSER`
- Provider keys.

**Tested so far:** Windows 11 (Node 22.16), inline mode. These are **not yet tested**: macOS, and the bullmq path against a real Redis/Memurai.

## 2. Docker mode (optional)

Requires Docker Desktop. Run `start.bat --docker` or `./start.command --docker`. To stop, run `stop.bat --docker`.

- **Services:** `postgres`, `redis`, `migrate` (one-shot), `api`, `worker`, `scheduler`, `web` (nginx serves the UI and proxies `/api`).
- **Ports:** only `127.0.0.1:${APP_PORT}` is published. Postgres and Redis are not exposed.
- **Database password:** the start script generates `POSTGRES_PASSWORD` into `.env` on first run.
- **Volumes:** `pgdata` and `redisdata`. `docker compose stop` keeps them; `docker compose down -v` deletes all data.

> **Status:** the Docker mode is written but **has not been run**, because the development machine has no Docker. It must be verified before anyone relies on it (tracked in PROGRESS.md).

## 3. Cloud / 24-7 (Master Plan §15.2) — documented, not yet run in a cloud
Use a small VM or container host. Run these services:
- **PostgreSQL:** managed, or the Compose `postgres` service. Set `DATABASE_URL`.
- **Redis:** managed, or the Compose `redis` service. Set `REDIS_URL` and `QUEUE_DRIVER=bullmq`.
- **Processes:** `api`, `worker` and `scheduler` (the Compose stack, or three processes).

Requirements before exposing anything beyond the machine:
1. **`API_TOKEN`**: 24+ random characters (`openssl rand -base64 32`). The API refuses a non-loopback `API_HOST` without it. Clients send `Authorization: Bearer <token>`: the web UI asks once per browser session, and the MCP server reads `API_TOKEN` from its environment. Known limitation: export download links opened in a new tab carry no token, so download through the UI page or an HTTP client.
2. **HTTPS reverse proxy.** Never publish port 3000/18966 directly. Example `Caddyfile`:
   ```
   spy.example.com {
     reverse_proxy 127.0.0.1:18966
   }
   ```
3. **Keep PostgreSQL and Redis private**: no public ports. This is already the case in `docker-compose.yml`.
4. **Secrets** go in the host's secret store or environment, never in git. Run `npm run security:check` before deploying.
5. **Backups:**
   - Set `BACKUP_PASSPHRASE`.
   - Copy `.data/backups/` (or `BACKUP_DIR`) to separate storage.
   - Run `npm run backup -- verify` regularly; that is the restore test.
6. **Monitoring:** scrape `GET /api/v1/metrics` (Prometheus format) with the bearer token. Alert on these:
   - `sss_jobs_oldest_queued_seconds` above 900;
   - `sss_jobs_failed_24h`;
   - `sss_scheduler_paused`;
   - provider health (`/api/v1/providers`).

Multi-user RBAC is out of scope for this single-user tool. The token gives full access, so share it only with trusted operators.
