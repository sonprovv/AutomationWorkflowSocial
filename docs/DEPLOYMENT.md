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

## 3. Cloud (24/7) — later
Master Plan §15.2. Use the Compose stack, or managed PostgreSQL and Redis. Before exposing the API beyond localhost, add TLS, authentication and RBAC (Phase 8).
