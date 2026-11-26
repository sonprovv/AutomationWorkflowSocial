-- One ACTIVE (QUEUED/RUNNING) job per idempotency key: DB-level guard against duplicate
-- enqueue from concurrent manual + scheduled runs (Master Plan section 8). Not expressible in Prisma schema.
CREATE UNIQUE INDEX "jobs_active_idempotency_key" ON "jobs" ("idempotency_key") WHERE "status" IN ('QUEUED', 'RUNNING');
