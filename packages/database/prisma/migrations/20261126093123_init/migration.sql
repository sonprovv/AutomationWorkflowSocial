-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'NOT_FOUND', 'PRIVATE_OR_REMOVED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TrackingStatus" AS ENUM ('TRACKING', 'PAUSED');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT,
    "platforms" TEXT[],
    "languages" TEXT[],
    "markets" TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "daily_budget_usd" DECIMAL(12,4),
    "monthly_budget_usd" DECIMAL(12,4),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" UUID NOT NULL,
    "brand_name" TEXT NOT NULL,
    "website" TEXT,
    "category" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_accounts" (
    "competitor_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "match_confidence" DOUBLE PRECISION,
    "evidence_url" TEXT,
    "verified_at" TIMESTAMPTZ(3),

    CONSTRAINT "competitor_accounts_pkey" PRIMARY KEY ("competitor_id","account_id")
);

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "username" TEXT,
    "display_name" TEXT,
    "profile_url" TEXT NOT NULL,
    "bio" TEXT,
    "avatar_url" TEXT,
    "account_created_at" TIMESTAMPTZ(3),
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "provider_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_collected_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_accounts" (
    "project_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "relevance_score" DOUBLE PRECISION,
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "tracking_status" "TrackingStatus" NOT NULL DEFAULT 'TRACKING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "next_sync_at" TIMESTAMPTZ(3),
    "last_sync_at" TIMESTAMPTZ(3),
    "last_sync_status" "JobStatus",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_accounts_pkey" PRIMARY KEY ("project_id","account_id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "title" TEXT,
    "caption" TEXT,
    "hashtags" TEXT[],
    "language" TEXT,
    "thumbnail_url" TEXT,
    "duration_seconds" INTEGER,
    "published_at" TIMESTAMPTZ(3),
    "sort_at" TIMESTAMPTZ(3) NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_collected_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'AVAILABLE',
    "provider_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_metrics" (
    "id" BIGSERIAL NOT NULL,
    "post_id" UUID NOT NULL,
    "collected_at" TIMESTAMPTZ(3) NOT NULL,
    "views" BIGINT,
    "likes" BIGINT,
    "comments" BIGINT,
    "shares" BIGINT,
    "saves" BIGINT,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "missing" JSONB NOT NULL DEFAULT '{}',
    "provider_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,

    CONSTRAINT "post_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_metrics" (
    "id" BIGSERIAL NOT NULL,
    "account_id" UUID NOT NULL,
    "collected_at" TIMESTAMPTZ(3) NOT NULL,
    "followers" BIGINT,
    "following" BIGINT,
    "posts_count" BIGINT,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "missing" JSONB NOT NULL DEFAULT '{}',
    "provider_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,

    CONSTRAINT "account_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" JSONB NOT NULL,
    "credential_ref" TEXT,
    "last_health" JSONB,
    "checked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_policies" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "allowed_operations" JSONB NOT NULL,
    "retention_days" INTEGER,
    "refresh_days" INTEGER,
    "notes" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "data_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "project_id" UUID,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "warnings" TEXT[],
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "retry_of_id" UUID,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_logs" (
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "job_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_runs" (
    "id" UUID NOT NULL,
    "job_id" UUID,
    "provider_id" TEXT NOT NULL,
    "account_id" UUID,
    "operation" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "quota_units" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "error_code" TEXT,
    "warnings" TEXT[],
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "collection_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "account_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "cursor" TEXT,
    "watermark" TIMESTAMPTZ(3),
    "backfill_done" BOOLEAN NOT NULL DEFAULT false,
    "last_success_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("account_id","provider_id")
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" BIGSERIAL NOT NULL,
    "provider_id" TEXT NOT NULL,
    "project_id" UUID,
    "job_id" UUID,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reserved_cost" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "actual_cost" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "day" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "workflow_key" TEXT NOT NULL,
    "cron" TEXT,
    "every_ms" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "next_run_at" TIMESTAMPTZ(3),
    "last_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_platform_external_id_key" ON "social_accounts"("platform", "external_id");

-- CreateIndex
CREATE INDEX "project_accounts_project_id_approval_status_idx" ON "project_accounts"("project_id", "approval_status");

-- CreateIndex
CREATE INDEX "project_accounts_next_sync_at_idx" ON "project_accounts"("next_sync_at");

-- CreateIndex
CREATE INDEX "posts_account_id_published_at_idx" ON "posts"("account_id", "published_at" DESC);

-- CreateIndex
CREATE INDEX "posts_sort_at_id_idx" ON "posts"("sort_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "posts_account_id_sort_at_id_idx" ON "posts"("account_id", "sort_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "posts_platform_external_id_key" ON "posts"("platform", "external_id");

-- CreateIndex
CREATE INDEX "post_metrics_post_id_collected_at_idx" ON "post_metrics"("post_id", "collected_at" DESC);

-- CreateIndex
CREATE INDEX "account_metrics_account_id_collected_at_idx" ON "account_metrics"("account_id", "collected_at" DESC);

-- CreateIndex
CREATE INDEX "jobs_idempotency_key_status_idx" ON "jobs"("idempotency_key", "status");

-- CreateIndex
CREATE INDEX "jobs_status_created_at_idx" ON "jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "jobs_resource_type_resource_id_created_at_idx" ON "jobs"("resource_type", "resource_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_logs_job_id_ts_idx" ON "job_logs"("job_id", "ts");

-- CreateIndex
CREATE INDEX "collection_runs_provider_id_started_at_idx" ON "collection_runs"("provider_id", "started_at");

-- CreateIndex
CREATE INDEX "usage_logs_provider_id_day_idx" ON "usage_logs"("provider_id", "day");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "competitor_accounts" ADD CONSTRAINT "competitor_accounts_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_accounts" ADD CONSTRAINT "competitor_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_accounts" ADD CONSTRAINT "project_accounts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_accounts" ADD CONSTRAINT "project_accounts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_metrics" ADD CONSTRAINT "account_metrics_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_policies" ADD CONSTRAINT "data_policies_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
