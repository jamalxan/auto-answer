"use client";

import { useEffect, useState } from "react";
import StatusBadge from "@/components/status-badge";
import { useLanguage } from "@/components/language-provider";
import AssistantDiagnostics from "@/components/assistant-diagnostics";
import { PageHeader } from "@/components/ui/page";

interface DiagnosticsData {
  canClearFailed?: boolean;
  queueCounts: Record<string, number>;
  workerHealth: {
    healthy: boolean;
    ageMs: number | null;
  };
  webhookFailures: Array<{
    id: string;
    object: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
  dmFailures: Array<{
    id: string;
    status: string;
    commentId: string;
    commentText: string;
    errorMessage: string | null;
    updatedAt: string;
    automation: { name: string };
  }>;
  tokenRefreshFailures: Array<{
    id: string;
    message: string;
    createdAt: string;
  }>;
  operationalEvents: Array<{
    id: string;
    source: string;
    level: string;
    message: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function EmptyState({ label }: { label: string }) {
  return <p className="py-5 text-center text-sm text-muted">{label}</p>;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel rounded-3xl p-5 sm:p-6">
      <h2 className="text-base font-bold text-white">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default function DiagnosticsPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  async function refreshDiagnostics() {
    setLoading(true);
    const response = await fetch("/api/admin/diagnostics");
    const payload = await response.json();
    if (payload.success) {
      setData(payload.data);
    }
    setLoading(false);
  }

  async function clearFailedJobs() {
    setClearing(true);
    await fetch("/api/admin/diagnostics/clear-failed", { method: "POST" });
    setClearing(false);
    await refreshDiagnostics();
  }

  useEffect(() => {
    let active = true;

    async function loadInitialDiagnostics() {
      const response = await fetch("/api/admin/diagnostics");
      const payload = await response.json();
      if (active && payload.success) {
        setData(payload.data);
      }
      if (active) {
        setLoading(false);
      }
    }

    void loadInitialDiagnostics();

    return () => {
      active = false;
    };
  }, []);

  if (loading && !data) {
    return <div className="panel h-64 animate-pulse rounded-3xl p-8" />;
  }

  const workerAgeSeconds =
    data?.workerHealth.ageMs == null
      ? null
      : Math.round(data.workerHealth.ageMs / 1000);

  return (
    <div className="space-y-6">
      <PageHeader
        description={t.diagnostics.subtitle}
        actions={
          <button
            type="button"
            onClick={() => void refreshDiagnostics()}
            className="btn btn-sm btn-ghost"
          >
            {t.diagnostics.refresh}
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
        <div className="panel rounded-2xl p-4 sm:p-5">
          <p className="break-words text-xs font-semibold leading-snug text-muted">
            {t.diagnostics.workerHealth}
          </p>
          <p
            className={`display wrap-anywhere mt-3 text-xl leading-tight sm:text-2xl ${
              data?.workerHealth.healthy ? "text-lime" : "text-warning"
            }`}
          >
            {data?.workerHealth.healthy ? t.diagnostics.healthy : t.diagnostics.needsAttention}
          </p>
          <p className="mt-3 text-xs leading-5 text-muted">
            {workerAgeSeconds == null
              ? t.diagnostics.noHeartbeat
              : t.diagnostics.lastHeartbeat(workerAgeSeconds)}
          </p>
        </div>
        {(
          [
            ["waiting", t.diagnostics.queueWaiting],
            ["active", t.diagnostics.queueActive],
            ["delayed", t.diagnostics.queueDelayed],
            ["failed", t.diagnostics.queueFailed],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="panel rounded-2xl p-4 sm:p-5">
            <p className="break-words text-xs font-semibold leading-snug text-muted">{label}</p>
            <p className="display mt-3 text-2xl tabular-nums text-white sm:text-[1.75rem]">
              {data?.queueCounts[key] ?? 0}
            </p>
            {key === "failed" &&
              data?.canClearFailed &&
              (data.queueCounts.failed ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={clearFailedJobs}
                  disabled={clearing}
                  className="btn btn-sm btn-danger mt-3"
                >
                  {clearing ? t.diagnostics.clearingFailed : t.diagnostics.clearFailed}
                </button>
              )}
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t.diagnostics.campaignDmFailures}>
          {data?.dmFailures.length ? (
            <div className="space-y-2">
              {data.dmFailures.map((item) => (
                <div key={item.id} className="inset px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                      {item.automation.name}
                    </p>
                    <StatusBadge status={item.status} />
                  </div>
                  <p className="mt-1 truncate text-xs text-muted">
                    {item.commentText}
                  </p>
                  {item.errorMessage && (
                    <p className="mt-1 text-xs text-error">{item.errorMessage}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label={t.diagnostics.noDmFailures} />
          )}
        </Section>

        <Section title={t.diagnostics.webhookFailures}>
          {data?.webhookFailures.length ? (
            <div className="space-y-2">
              {data.webhookFailures.map((event) => (
                <div key={event.id} className="inset px-4 py-3">
                  <p className="text-sm font-semibold text-white">
                    {event.object ?? t.diagnostics.instagramWebhookFallback}
                  </p>
                  <p className="mt-1 text-xs text-error">
                    {event.errorMessage ?? t.diagnostics.unknownError}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(event.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label={t.diagnostics.noWebhookFailures} />
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t.diagnostics.tokenRefreshFailures}>
          {data?.tokenRefreshFailures.length ? (
            <div className="space-y-2">
              {data.tokenRefreshFailures.map((event) => (
                <div key={event.id} className="inset px-4 py-3">
                  <p className="text-sm font-semibold text-white">
                    {event.message}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(event.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label={t.diagnostics.noTokenRefreshFailures} />
          )}
        </Section>

      </div>

      <AssistantDiagnostics />

      <Section title={t.diagnostics.operationalEventTimeline}>
        {data?.operationalEvents.length ? (
          <div className="space-y-2">
            {data.operationalEvents.map((event) => (
              <div key={event.id} className="inset grid gap-2 px-4 py-3 sm:grid-cols-[140px_1fr_auto]">
                <p className="text-xs font-semibold text-muted">{event.source}</p>
                <p className="text-sm text-white">{event.message}</p>
                <p className="text-xs text-muted">{formatDate(event.createdAt)}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label={t.diagnostics.noOperationalEvents} />
        )}
      </Section>
    </div>
  );
}
