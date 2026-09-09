import type { Metadata } from "next";
import { getAllPricingPlans } from "@/lib/pricing";
import { savePricingPlan, deletePricingPlan } from "@/lib/admin/actions";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import AdminConfirmForm from "@/components/admin-confirm-form";
import AdminPricingPlanForm from "@/components/admin-pricing-plan-form";

export const metadata: Metadata = {
  title: "Pricing - Admin",
  robots: { index: false, follow: false },
};

const EMPTY_CONTENT = {
  uz: { name: "", description: "", features: [] },
  ru: { name: "", description: "", features: [] },
  en: { name: "", description: "", features: [] },
};

export default async function AdminPricingPage() {
  const [pricingPlans, locale] = await Promise.all([getAllPricingPlans(), getServerLocale()]);
  const t = dictionaries[locale].admin;

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h1 className="font-display text-xl font-extrabold text-foreground">{t.pricingTitle}</h1>
      <p className="mt-1 text-sm text-muted">{t.pricingSubtitle}</p>

      <div className="mt-6 space-y-6">
        {pricingPlans.map((plan) => (
          <div key={plan.id} className="rounded border-2 border-border p-4">
            <form action={savePricingPlan}>
              <input type="hidden" name="id" value={plan.id} />
              <AdminPricingPlanForm
                labels={t}
                slug={plan.slug}
                slugLocked
                priceAmount={plan.priceAmount}
                priceCurrency={plan.priceCurrency}
                priceSuffix={plan.priceSuffix}
                sortOrder={plan.sortOrder}
                isFeatured={plan.isFeatured}
                isActive={plan.isActive}
                content={plan.content}
              />
              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  className="label-mono rounded bg-accent px-4 py-1.5 text-xs font-bold text-background transition hover:bg-accent-hover"
                >
                  {t.pricingSave}
                </button>
                <AdminConfirmForm
                  action={deletePricingPlan}
                  confirmMessage={t.pricingConfirmDelete}
                  label={t.pricingDelete}
                  hiddenFields={{ id: plan.id }}
                  className="label-mono rounded border-2 border-red-500/40 px-4 py-1.5 text-xs font-bold text-red-500 transition hover:bg-red-500/10"
                />
              </div>
            </form>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded border-2 border-dashed border-border p-4">
        <h2 className="text-xs font-bold text-foreground">{t.pricingAddTitle}</h2>
        <form action={savePricingPlan} className="mt-3">
          <AdminPricingPlanForm
            labels={t}
            slug=""
            slugLocked={false}
            slugPlaceholder={t.pricingNewSlugPlaceholder}
            priceAmount={0}
            priceCurrency="$"
            priceSuffix="/mo"
            sortOrder={pricingPlans.length}
            isFeatured={false}
            isActive={true}
            content={EMPTY_CONTENT}
          />
          <div className="mt-4">
            <button
              type="submit"
              className="label-mono rounded bg-accent px-4 py-1.5 text-xs font-bold text-background transition hover:bg-accent-hover"
            >
              {t.pricingSave}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
