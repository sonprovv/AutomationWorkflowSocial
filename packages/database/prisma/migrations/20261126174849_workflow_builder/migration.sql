-- CreateTable
CREATE TABLE "workflow_defs" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflow_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '{}',
    "job_id" UUID,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_key" ON "workflow_versions"("workflow_id", "version");

-- CreateIndex
CREATE INDEX "workflow_runs_workflow_id_started_at_idx" ON "workflow_runs"("workflow_id", "started_at" DESC);
