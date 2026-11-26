# ADR-0016: Security hardening, encrypted backups, observability, load limits

- **Status:** Accepted
- **Date:** 2026-11-27
- **Phase:** 8

## Decisions

### 1. Security
- **Response headers** on every response:
  - `content-security-policy`: self only, `frame-ancestors 'none'`, `img-src https:` for provider avatars;
  - `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `permissions-policy`;
  - no CORS headers.
- **Remote exposure needs a token.** The API binds to loopback by default. Config validation refuses any other `API_HOST` unless `API_TOKEN` (24+ characters) is set. With a token, every `/api` request except liveness needs `Authorization: Bearer <token>`, compared in constant time.
  - The UI asks for the token once per browser session.
  - The MCP server sends it.
  - Docker sets `API_CONTAINER_NETWORK=true`, because its API binds 0.0.0.0 only inside the container network and the published port stays on 127.0.0.1.
- **`npm run security:check`** (`docs/phase8/security-*.json`):
  - scans tracked files for secret patterns;
  - checks that `.env` and `.data/*` (database, backups, key, exports, evidence) are git-ignored and not tracked;
  - checks that `.env.example` has empty secret values;
  - checks safe defaults;
  - runs `npm audit --omit=dev`.
- **Dependency fix:** the first audit found nodemailer 8.0.11 vulnerable (high). It was upgraded to 10.3.1, a release more than 2 weeks old; the audit is now clean.
- **Already in place from earlier phases** and covered by tests:
  - secrets redacted from logs and errors;
  - SSRF host allowlist in the collectors;
  - formula-injection defence in exports;
  - untrusted-input isolation for AI.

### 2. Backups (WF15 daily at 02:00, `npm run backup`)
- **Format:** a logical backup made inside PostgreSQL (`row_to_json` / `json_populate_recordset`), so types round-trip exactly. It works without `pg_dump`, which the embedded PostgreSQL does not ship.
  - One REPEATABLE READ snapshot.
  - gzip, then AES-256-GCM.
  - A manifest with migrations, row counts and an order-independent checksum per table.
- **Key:** `BACKUP_PASSPHRASE` (scrypt), or a random key created once in `.data/backup.key`. The user must keep a copy of the key elsewhere.
- **Restore** goes only into a **new, empty** database with the same migrations, restores parent tables before child tables (foreign keys), resets sequences and verifies every table. The live database is never overwritten.
  - `npm run backup -- verify` is the restore test: restore into a temporary database, verify, drop.
  - Real run on the local app database (2026-11-27): 29 tables, 107 rows, all checksums matched.
- **Rotation:** `BACKUP_KEEP` (default 7). Backups are not a reason to keep data past its retention.

### 3. Observability
`GET /api/v1/metrics` (Prometheus text format, no dependency):
- HTTP request counters and latency histograms per route;
- process uptime and RSS;
- active jobs and the age of the oldest queued job;
- failed jobs in the last 24 h;
- posts and accounts;
- provider usage, cost and active reservations today;
- collection runs in the last 24 h by status;
- whether the scheduler is paused.

Logs stay structured pino JSON with request ids.

### 4. Load (`npm run load:test` → `docs/phase8/load-*.json`)
- **Dataset:** SYNTHETIC only, in a throwaway database: 200 accounts, 50,000 posts and 50,000 metric snapshots.
- **Results on this laptop**, with 10–20 concurrent clients:
  - every endpoint answered with 0 errors;
  - deep keyset pagination stays flat: about 10 ms per page over 100 pages, using the `(sort_at, id)` index;
  - an export of 50,000 rows takes about 6.5 s and makes a 4 MB file.
- **Two defects found and fixed:**
  1. **Export:** a single `findMany` with an include over 50k rows exceeded PostgreSQL's 32,767 bind parameters, so the export failed. Exports now read in keyset batches of 5,000 rows, and the analytics sheets no longer use unbounded `IN` lists.
  2. **Dashboard:** p50 was about 800 ms under 10 concurrent clients. A 15 s in-process cache per database and project brought it to about 7 ms; a cold request takes about 190 ms.

### 5. Deployment
The cloud and 24/7 path is documented in `docs/DEPLOYMENT.md` §3:
- HTTPS reverse proxy;
- `API_TOKEN`;
- managed PostgreSQL and Redis;
- `QUEUE_DRIVER=bullmq` with the separate worker and scheduler;
- backups to separate storage.

It has not been run in a cloud.

## Open
- **Not run on this machine:** Docker mode, macOS, and a real cloud deployment.
- **Not tested here:** the BullMQ path. It needs Redis.
