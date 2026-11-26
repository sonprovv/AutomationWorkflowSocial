-- CreateTable
CREATE TABLE "exports" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "filters" JSONB NOT NULL DEFAULT '{}',
    "row_counts" JSONB NOT NULL DEFAULT '{}',
    "withheld" JSONB NOT NULL DEFAULT '[]',
    "file_name" TEXT,
    "size_bytes" INTEGER,
    "job_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exports_created_at_idx" ON "exports"("created_at" DESC);
