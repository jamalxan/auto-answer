"use client";

/**
 * "Kontent navbati" (M10): one line of numbers above the calendar — what is
 * waiting, what is moving through the pipeline, what failed or went out in
 * the last day, and the BullMQ depth. Overdue posts mean the worker or the
 * sweeper is not running.
 */

import { useEffect, useState } from "react";
import { Pill } from "./ui";
import { formatZoned, utcToZoned } from "@/lib/content/time";
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

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "error" | "warning" | "lime" }) {
  const color = tone === "error" ? "text-error" : tone === "warning" ? "text-warning" : tone === "lime" ? "text-lime" : "text-white";
  return (
    <div className="inset min-w-0 px-4 py-3">
      <div className={`display truncate text-xl tabular-nums ${color}`}>{value}</div>
      <div className="mt-1 truncate text-xs text-muted">{label}</div>
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
  // Big time, the day under it: "20:00" / "Keyingisi · 26-okt" never truncates in a tile.
  const nextAt = stats.next ? utcToZoned(new Date(stats.next.scheduledAt), timezone) : null;
  const nextDay = nextAt ? (nextAt.date === utcToZoned(new Date(), timezone).date ? "bugun" : formatZoned(new Date(stats.next!.scheduledAt), timezone).split(",")[0]) : null;

  return (
    <section className="panel rounded-3xl p-4 sm:p-5" aria-label="Kontent navbati">
      {(stats.overdue > 0 || !stats.queues) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {stats.overdue > 0 && <Pill tone="error">{stats.overdue} ta post vaqtidan o&apos;tib turibdi — worker ishlayaptimi?</Pill>}
          {!stats.queues && <Pill tone="muted">Navbat serveri ulanmagan</Pill>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Rejada" value={s.SCHEDULED ?? 0} />
        <Stat label="Chiqarilmoqda" value={inFlight} />
        <Stat label="Qo'lda kutmoqda" value={s.NEEDS_MANUAL ?? 0} tone={(s.NEEDS_MANUAL ?? 0) > 0 ? "warning" : undefined} />
        <Stat label="Chiqdi · 24 soat" value={stats.published24h} tone={stats.published24h > 0 ? "lime" : undefined} />
        <Stat label="Xato · 24 soat" value={stats.failed24h} tone={stats.failed24h > 0 ? "error" : undefined} />
        <Stat label={nextDay ? `Keyingisi · ${nextDay}` : "Keyingisi"} value={nextAt?.time ?? "—"} />
      </div>
    </section>
  );
}
