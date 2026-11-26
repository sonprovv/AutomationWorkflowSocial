-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "last_result" JSONB,
ADD COLUMN     "last_status" TEXT;

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "usage_reservations" (
    "id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "project_id" UUID,
    "job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "settled_at" TIMESTAMPTZ(3),
    "used" INTEGER,

    CONSTRAINT "usage_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_reservations_provider_id_unit_day_settled_at_idx" ON "usage_reservations"("provider_id", "unit", "day", "settled_at");

-- CreateIndex
CREATE INDEX "schedules_enabled_next_run_at_idx" ON "schedules"("enabled", "next_run_at");
