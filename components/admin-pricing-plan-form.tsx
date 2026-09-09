import type { Locale } from "@/lib/i18n/config";
import type { PricingPlanLocaleContent } from "@/lib/pricing";

const LOCALES: Locale[] = ["uz", "ru", "en"];

interface Labels {
  pricingFieldSlug: string;
  pricingFieldPrice: string;
  pricingFieldCurrency: string;
  pricingFieldSuffix: string;
  pricingFieldOrder: string;
  pricingFieldFeatured: string;
  pricingFieldActive: string;
  pricingFieldName: string;
  pricingFieldDescription: string;
  pricingFieldFeatures: string;
  pricingFeaturesHint: string;
  pricingLocaleUz: string;
  pricingLocaleRu: string;
  pricingLocaleEn: string;
  pricingSave: string;
}

const inputClass =
  "mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none";

/**
 * The plan editor: plain per-locale text fields (name/description/one
 * feature per line) instead of hand-typed JSON. Shared between an existing
 * plan's edit form and the blank "add a plan" form below it.
 */
export default function AdminPricingPlanForm({
  labels,
  slug,
  slugLocked,
  priceAmount,
  priceCurrency,
  priceSuffix,
  sortOrder,
  isFeatured,
  isActive,
  content,
  slugPlaceholder,
}: {
  labels: Labels;
  slug: string;
  slugLocked: boolean;
  priceAmount: number;
  priceCurrency: string;
  priceSuffix: string;
  sortOrder: number;
  isFeatured: boolean;
  isActive: boolean;
  content: Record<Locale, PricingPlanLocaleContent>;
  slugPlaceholder?: string;
}) {
  const localeLabel: Record<Locale, string> = {
    uz: labels.pricingLocaleUz,
    ru: labels.pricingLocaleRu,
    en: labels.pricingLocaleEn,
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-6">
        <label className="text-xs text-muted sm:col-span-2">
          {labels.pricingFieldSlug}
          {slugLocked ? (
            <input
              disabled
              defaultValue={slug}
              className="mt-1 w-full rounded border-2 border-border bg-surface px-2 py-1.5 text-sm text-muted"
            />
          ) : (
            <input name="slug" placeholder={slugPlaceholder} className={inputClass} />
          )}
        </label>
        <label className="text-xs text-muted">
          {labels.pricingFieldPrice}
          <input
            type="number"
            name="priceAmount"
            defaultValue={priceAmount}
            className={inputClass}
          />
        </label>
        <label className="text-xs text-muted">
          {labels.pricingFieldCurrency}
          <input name="priceCurrency" defaultValue={priceCurrency} className={inputClass} />
        </label>
        <label className="text-xs text-muted">
          {labels.pricingFieldSuffix}
          <input name="priceSuffix" defaultValue={priceSuffix} className={inputClass} />
        </label>
        <label className="text-xs text-muted">
          {labels.pricingFieldOrder}
          <input
            type="number"
            name="sortOrder"
            defaultValue={sortOrder}
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" name="isFeatured" defaultChecked={isFeatured} />
          {labels.pricingFieldFeatured}
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" name="isActive" defaultChecked={isActive} />
          {labels.pricingFieldActive}
        </label>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {LOCALES.map((locale) => (
          <div key={locale} className="rounded border-2 border-border p-3">
            <p className="label-mono text-[11px] font-bold text-accent">
              {localeLabel[locale]}
            </p>
            <label className="mt-2 block text-xs text-muted">
              {labels.pricingFieldName}
              <input
                name={`name_${locale}`}
                defaultValue={content[locale]?.name ?? ""}
                className={inputClass}
              />
            </label>
            <label className="mt-2 block text-xs text-muted">
              {labels.pricingFieldDescription}
              <textarea
                name={`description_${locale}`}
                rows={2}
                defaultValue={content[locale]?.description ?? ""}
                className={inputClass}
              />
            </label>
            <label className="mt-2 block text-xs text-muted">
              {labels.pricingFieldFeatures}
              <textarea
                name={`features_${locale}`}
                rows={4}
                defaultValue={(content[locale]?.features ?? []).join("\n")}
                className={`${inputClass} font-mono`}
              />
              <span className="mt-1 block text-[11px] text-muted">
                {labels.pricingFeaturesHint}
              </span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
