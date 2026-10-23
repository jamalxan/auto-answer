"use client";

/**
 * "Kontent navbati" (M10): one line of numbers above the calendar — what is
 * waiting, what is moving through the pipeline, what failed or went out in
 * the last day, and the BullMQ depth. Overdue posts mean the worker or the
 * sweeper is not running.
 */

import { useEffect, useState } from "react";
import { Pill } from "@/components/developer/ui";
import { formatZoned } from "@/lib/content/time";
import { CONTENT_API, requestJson } from "./shared";

interface QueueCounts {
  waiting: number;
  delayed: number;
  active: number;
  failed: number;
}

interface QueueStats {
  statuses: Record<string, number>;
  failed24h: number;
  published24h: number;
  next: { id: string; scheduledAt: string } | null;
  overdue: number;
  queues: { publish: QueueCounts; media: QueueCounts } | null;
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "error" | "warning" }) {
  return (
    <div className="min-w-[88px]">
      <div className={`font-display text-lg font-bold tabular-nums ${tone === "error" ? "text-error" : tone === "warning" ? "text-warning" : ""}`}>{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

export default function QueueCard({ timezone, refreshKey }: { timezone: string; refreshKey: number }) {
  const [stats, setStats] = useState<QueueStats | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await requestJson<QueueStats>(`${CONTENT_API}/queue-stats`);
      if (alive && res.ok) setStats(res.data);
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshKey]);

  if (!stats) return null;
  const s = stats.statuses;
  const inFlight = (s.PREPARING ?? 0) + (s.READY_TO_PUBLISH ?? 0) + (s.PUBLISHING ?? 0);
  const next = stats.next ? formatZoned(new Date(stats.next.scheduledAt), timezone) : "—";

  return (
    <section className="rounded-2xl border border-border bg-surface px-4 py-3" aria-label="Kontent navbati">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="label-mono text-[11px] font-semibold text-muted">Kontent navbati</span>
        {stats.overdue > 0 && <Pill tone="error">{stats.overdue} ta post vaqtidan o&apos;tib turibdi — worker ishlayaptimi?</Pill>}
        {!stats.queues && <Pill tone="muted">Redis yo&apos;q — navbat ko&apos;rinmaydi</Pill>}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Stat label="Rejada" value={s.SCHEDULED ?? 0} />
        <Stat label="Chiqarilmoqda" value={inFlight} />
        <Stat label="Qo'lda kutmoqda" value={s.NEEDS_MANUAL ?? 0} tone={(s.NEEDS_MANUAL ?? 0) > 0 ? "warning" : undefined} />
        <Stat label="Chiqdi · 24 soat" value={stats.published24h} />
        <Stat label="Xato · 24 soat" value={stats.failed24h} tone={stats.failed24h > 0 ? "error" : undefined} />
        <Stat label="Keyingisi" value={next} />
        {stats.queues && (
          <Stat
            label="Navbat (kutish / ishda / xato)"
            value={`${stats.queues.publish.waiting + stats.queues.publish.delayed} / ${stats.queues.publish.active + stats.queues.media.active} / ${stats.queues.publish.failed + stats.queues.media.failed}`}
          />
        )}
      </div>
    </section>
  );
}
