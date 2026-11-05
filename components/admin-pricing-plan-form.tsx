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

const inputClass = "input mt-1.5";

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
        <label className="text-sm font-medium text-cloud/85 sm:col-span-2">
          {labels.pricingFieldSlug}
          {slugLocked ? (
            <input
              disabled
              defaultValue={slug}
              className="input mt-1.5"
            />
          ) : (
            <input name="slug" placeholder={slugPlaceholder} className={inputClass} />
          )}
        </label>
        <label className="text-sm font-medium text-cloud/85">
          {labels.pricingFieldPrice}
          <input
            type="number"
            name="priceAmount"
            defaultValue={priceAmount}
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium text-cloud/85">
          {labels.pricingFieldCurrency}
          <input name="priceCurrency" defaultValue={priceCurrency} className={inputClass} />
        </label>
        <label className="text-sm font-medium text-cloud/85">
          {labels.pricingFieldSuffix}
          <input name="priceSuffix" defaultValue={priceSuffix} className={inputClass} />
        </label>
        <label className="text-sm font-medium text-cloud/85">
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
        <label className="flex items-center gap-2 text-sm font-medium text-cloud/85">
          <input type="checkbox" name="isFeatured" defaultChecked={isFeatured} />
          {labels.pricingFieldFeatured}
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-cloud/85">
          <input type="checkbox" name="isActive" defaultChecked={isActive} />
          {labels.pricingFieldActive}
        </label>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {LOCALES.map((locale) => (
          <div key={locale} className="rounded-2xl border border-white/8 p-4">
            <p className="text-sm font-bold text-lime">
              {localeLabel[locale]}
            </p>
            <label className="mt-2 block text-sm font-medium text-cloud/85">
              {labels.pricingFieldName}
              <input
                name={`name_${locale}`}
                defaultValue={content[locale]?.name ?? ""}
                className={inputClass}
              />
            </label>
            <label className="mt-2 block text-sm font-medium text-cloud/85">
              {labels.pricingFieldDescription}
              <textarea
                name={`description_${locale}`}
                rows={2}
                defaultValue={content[locale]?.description ?? ""}
                className={inputClass}
              />
            </label>
            <label className="mt-2 block text-sm font-medium text-cloud/85">
              {labels.pricingFieldFeatures}
              <textarea
                name={`features_${locale}`}
                rows={4}
                defaultValue={(content[locale]?.features ?? []).join("\n")}
                className={`${inputClass} font-mono`}
              />
              <span className="mt-1 block text-xs text-muted">
                {labels.pricingFeaturesHint}
              </span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
