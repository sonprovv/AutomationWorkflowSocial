-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "markdown" TEXT NOT NULL,
    "export_id" UUID,
    "job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_project_id_created_at_idx" ON "reports"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_channel_dedup_key_key" ON "notifications"("channel", "dedup_key");
