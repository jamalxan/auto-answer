-- CreateTable
CREATE TABLE "PricingPlan" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "priceAmount" INTEGER NOT NULL DEFAULT 0,
    "priceCurrency" TEXT NOT NULL DEFAULT '$',
    "priceSuffix" TEXT NOT NULL DEFAULT '/mo',
    "content" JSONB NOT NULL,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PricingPlan_slug_key" ON "PricingPlan"("slug");

-- CreateIndex
CREATE INDEX "PricingPlan_sortOrder_idx" ON "PricingPlan"("sortOrder");
