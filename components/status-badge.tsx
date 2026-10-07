"use client";

/**
 * Status pill for DM status; color carries the state.
 */

import { useLanguage } from "@/components/language-provider";

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const { t } = useLanguage();

  const statusConfig: Record<string, { text: string; label: string }> = {
    SENT: { text: "text-success", label: t.status.sent },
    FAILED: { text: "text-error", label: t.status.failed },
    PENDING: { text: "text-warning", label: t.status.pending },
    SKIPPED_DEDUP: { text: "text-muted", label: t.status.dedup },
    SKIPPED_RATE_LIMIT: { text: "text-warning", label: t.status.rateLimited },
    SKIPPED_PLAN_LIMIT: { text: "text-warning", label: t.status.skippedPlan },
    SKIPPED_NO_MATCH: { text: "text-muted", label: t.status.noMatch },
  };

  const config = statusConfig[status] ?? statusConfig.PENDING;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-current/10 px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ring-current/20 ${config.text}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {config.label}
    </span>
  );
}
