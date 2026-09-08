"use client";

/**
 * Status label for DM status. Plain text; color carries the state.
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
    <span className={`shrink-0 whitespace-nowrap text-sm ${config.text}`}>
      {config.label}
    </span>
  );
}
