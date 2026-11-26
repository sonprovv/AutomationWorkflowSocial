-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "last_metrics_at" TIMESTAMPTZ(3),
ADD COLUMN     "provider_indexed_at" TIMESTAMPTZ(3),
ADD COLUMN     "unavailable_at" TIMESTAMPTZ(3),
ADD COLUMN     "unavailable_reason" TEXT;

-- CreateIndex
CREATE INDEX "posts_status_last_metrics_at_idx" ON "posts"("status", "last_metrics_at");
