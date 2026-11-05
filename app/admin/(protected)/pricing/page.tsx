import type { Metadata } from "next";
import { getAllPricingPlans } from "@/lib/pricing";
import { savePricingPlan, deletePricingPlan } from "@/lib/admin/actions";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import AdminConfirmSubmitButton from "@/components/admin-confirm-submit-button";
import AdminPricingPlanForm from "@/components/admin-pricing-plan-form";
import { adminCopy } from "@/lib/admin/copy";
import { AdminTitle } from "@/components/admin/parts";

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
  const c = adminCopy(locale);

  return (
    <div className="space-y-6">
      <AdminTitle title={c.pricingTitle} sub={c.pricingSub} />

      <div className="space-y-4">
        {pricingPlans.map((plan) => (
          <div key={plan.id} className="panel rounded-3xl p-5 sm:p-6">
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
                  className="btn btn-sm btn-primary"
                >
                  {t.pricingSave}
                </button>
                <AdminConfirmSubmitButton
                  formAction={deletePricingPlan}
                  confirmMessage={t.pricingConfirmDelete}
                  label={t.pricingDelete}
                  className="btn btn-sm btn-danger"
                />
              </div>
            </form>
          </div>
        ))}
      </div>

      <div className="panel rounded-3xl !border-dashed !border-white/15 p-5 sm:p-6">
        <h2 className="text-base font-bold text-white">{c.pricingAdd}</h2>
        <form action={savePricingPlan} className="mt-4">
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
              className="btn btn-sm btn-primary"
            >
              {t.pricingSave}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
