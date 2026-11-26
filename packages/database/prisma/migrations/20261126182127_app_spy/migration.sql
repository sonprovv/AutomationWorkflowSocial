-- CreateTable
CREATE TABLE "apps" (
    "id" UUID NOT NULL,
    "store" TEXT NOT NULL,
    "store_app_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "bundle_id" TEXT,
    "name" TEXT NOT NULL,
    "developer_id" TEXT,
    "developer_name" TEXT,
    "seller_name" TEXT,
    "website_url" TEXT,
    "store_url" TEXT NOT NULL,
    "developer_url" TEXT,
    "genre" TEXT,
    "price" DECIMAL(12,2),
    "currency" TEXT,
    "rating" DOUBLE PRECISION,
    "rating_count" INTEGER,
    "version" TEXT,
    "released_at" TIMESTAMPTZ(3),
    "store_updated_at" TIMESTAMPTZ(3),
    "description" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "provider_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "collected_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_apps" (
    "project_id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_apps_pkey" PRIMARY KEY ("project_id","app_id")
);

-- CreateTable
CREATE TABLE "app_social_links" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "profile_url" TEXT NOT NULL,
    "account_id" UUID,
    "method" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "evidence" JSONB NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_social_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "apps_developer_id_idx" ON "apps"("developer_id");

-- CreateIndex
CREATE UNIQUE INDEX "apps_store_store_app_id_country_key" ON "apps"("store", "store_app_id", "country");

-- CreateIndex
CREATE INDEX "project_apps_app_id_idx" ON "project_apps"("app_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_social_links_app_id_platform_handle_key" ON "app_social_links"("app_id", "platform", "handle");

-- AddForeignKey
ALTER TABLE "project_apps" ADD CONSTRAINT "project_apps_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_apps" ADD CONSTRAINT "project_apps_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_social_links" ADD CONSTRAINT "app_social_links_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_social_links" ADD CONSTRAINT "app_social_links_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
