# ADR-0008: Native local runtime by default; Docker Compose optional

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 1

## Context
- Master Plan §15.1 proposes Docker Compose for the local MVP.
- The development machine runs Windows 11 and has neither Docker nor WSL.
- The Product Owner asked for the lightest option ("ưu tiên nhẹ cho tôi").
- Docker Desktop needs admin rights, WSL2 and possibly a reboot, and it is heavy to keep running.

We evaluated alternatives on this machine on 2026-11-26:
- **Embedded PostgreSQL** (the `embedded-postgres` npm package, which ships official PostgreSQL binaries for each OS and architecture): works. The first `initdb` takes about 12 s.
- **Garnet** (a Microsoft server that speaks the Redis protocol): **not compatible with BullMQ**. Version 1.0.84 has no Redis Streams (`XREAD`) and rejects some commands inside Lua scripts. Newer Garnet releases do not install on the .NET 8 SDK.
- **BullMQ 6's experimental PostgreSQL backend:** undocumented in the README, so we do not rely on it.

## Decision
1. **Native mode is the default.** It is what `start.bat` and `start.command` run.
   - A Node supervisor (`tools/local/src/start.ts`) starts a **persistent embedded PostgreSQL 17**. The data lives in `.data/postgres`, and a random password is generated into `.data/postgres.secret`.
   - It applies migrations and seeds, then runs api, worker and scheduler as child processes.
   - The API serves the built UI from the same origin on `APP_PORT`.
   - It stops gracefully through a stop-request file and IPC messages. These work on Windows, where a child process cannot catch signals.
2. **Redis:** any Redis-compatible server that BullMQ supports.
   - On Windows, the recommendation is **Memurai Developer** (`winget install Memurai.MemuraiDeveloper`).
   - On macOS, `brew install redis`.
3. **When Redis is unreachable**, the supervisor falls back to **inline mode**. The `InlineDispatcher` runs the *same* job processor inside the API process, with the same retry and dedup semantics.
   - Inline mode has **no** worker and **no** scheduler, and the start screen says so.
   - Config validation refuses `QUEUE_DRIVER=inline` in production.
   - Tests use inline mode too, so they run without Redis.
4. **Docker Compose stays available** (`start.bat --docker`) as the path to running 24/7 in the cloud (§15.2). Its PostgreSQL uses the same UTF-8 + ICU initdb flags as the embedded one.
5. **Embedded PostgreSQL is initialised with `--encoding=UTF8 --locale-provider=icu --icu-locale=und`.**
   - On Windows, the default WIN1252 encoding rejected emoji. A real-data run found this.
   - With the C locale, Vietnamese text cannot be case-folded, so `ILIKE` failed.

## Consequences
- No admin rights or system install is needed for the database. Redis is the only optional install.
- Inline mode does not run scheduled workflows (WF13 and the Phase 4 schedules). This is shown in the UI, in `doctor` and in `/health/ready` (`queueDriver`).
- The Docker Compose path is written but **has not been run**, because no Docker is available. It must be verified on a machine that has Docker.
- Native mode is single-user and single-machine. Cloud deployment uses Compose or a managed Postgres and Redis.
