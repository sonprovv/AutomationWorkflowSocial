-- CreateEnum
CREATE TYPE "KeywordStatus" AS ENUM ('SUGGESTED', 'ACTIVE', 'PAUSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KeywordOrigin" AS ENUM ('MANUAL', 'RULE', 'AI');

-- CreateEnum
CREATE TYPE "CandidateClass" AS ENUM ('DIRECT_COMPETITOR', 'ADJACENT_COMPETITOR', 'CREATOR', 'PUBLISHER', 'IRRELEVANT', 'UNKNOWN');

-- CreateTable
CREATE TABLE "keywords" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "normalized_text" TEXT NOT NULL,
    "language" TEXT,
    "origin" "KeywordOrigin" NOT NULL DEFAULT 'MANUAL',
    "status" "KeywordStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "parent_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_candidates" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "classification" "CandidateClass" NOT NULL DEFAULT 'UNKNOWN',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" TEXT,
    "discovered_by_job_id" UUID,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discovery_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_results" (
    "id" BIGSERIAL NOT NULL,
    "project_id" UUID NOT NULL,
    "keyword_id" UUID,
    "job_id" UUID,
    "provider_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "account_external_id" TEXT NOT NULL,
    "post_external_id" TEXT,
    "url" TEXT,
    "collected_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "search_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "keywords_project_id_status_idx" ON "keywords"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "keywords_project_id_normalized_text_key" ON "keywords"("project_id", "normalized_text");

-- CreateIndex
CREATE INDEX "discovery_candidates_project_id_approval_status_score_idx" ON "discovery_candidates"("project_id", "approval_status", "score" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "discovery_candidates_project_id_account_id_key" ON "discovery_candidates"("project_id", "account_id");

-- CreateIndex
CREATE INDEX "search_results_project_id_collected_at_idx" ON "search_results"("project_id", "collected_at" DESC);

-- CreateIndex
CREATE INDEX "search_results_keyword_id_idx" ON "search_results"("keyword_id");

-- AddForeignKey
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE SET NULL ON UPDATE CASCADE;
