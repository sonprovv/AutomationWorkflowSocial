-- CreateTable
CREATE TABLE "viral_scores" (
    "id" BIGSERIAL NOT NULL,
    "project_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "label" TEXT,
    "version" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "policy_id" TEXT NOT NULL,
    "scored_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "viral_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_analysis" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "project_id" UUID,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "confidence" DOUBLE PRECISION,
    "scope" TEXT NOT NULL DEFAULT 'metadata',
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trend_snapshots" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "window_days" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "topics" JSONB NOT NULL,
    "coverage" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trend_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "viral_scores_project_id_score_idx" ON "viral_scores"("project_id", "score" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "viral_scores_project_id_post_id_version_key" ON "viral_scores"("project_id", "post_id", "version");

-- CreateIndex
CREATE INDEX "content_analysis_project_id_created_at_idx" ON "content_analysis"("project_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "content_analysis_post_id_model_prompt_version_input_hash_key" ON "content_analysis"("post_id", "model", "prompt_version", "input_hash");

-- CreateIndex
CREATE INDEX "trend_snapshots_project_id_computed_at_idx" ON "trend_snapshots"("project_id", "computed_at" DESC);
