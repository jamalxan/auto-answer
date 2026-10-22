"use client";

import type { CampaignTemplate } from "@/lib/templates/campaign-templates";
import { useLanguage } from "@/components/language-provider";

interface TemplateVisualProps {
  template: CampaignTemplate;
  compact?: boolean;
}

export default function TemplateVisual({
  template,
  compact = false,
}: TemplateVisualProps) {
  const { t } = useLanguage();
  return (
    <div className="panel rounded-3xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted">
            {t.publicSite.triggerLabel}
          </p>
          <p className="mt-1 text-sm font-bold text-white">
            {template.triggerExample}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-muted">
          {template.category}
        </span>
      </div>

      <div className={`mt-4 grid gap-3 ${compact ? "" : "sm:grid-cols-2"}`}>
        <div className="inset p-4">
          <p className="text-xs font-semibold text-muted">
            {t.publicSite.keywordsLabel}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {template.keywords.map((keyword) => (
              <span
                key={keyword}
                className="rounded-full bg-lime/12 px-2.5 py-1 text-xs font-semibold text-lime"
              >
                {keyword}
              </span>
            ))}
          </div>
        </div>
        <div className="inset p-4">
          <p className="text-xs font-semibold text-muted">
            {t.publicSite.privateReplyLabel}
          </p>
          <p className="mt-3 text-sm leading-6 text-white">
            {template.privateReplyPreview}
          </p>
        </div>
      </div>
    </div>
  );
}
