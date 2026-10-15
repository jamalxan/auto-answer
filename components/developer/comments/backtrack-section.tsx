"use client";

/**
 * "Eski kommentlarga ham yuborish" (TZ 11). Meta allows a private reply only
 * within 7 days of the comment, so the scan goes back at most 7 days. Runs are
 * polled while one is still RUNNING.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { COMMENT_LIMITS as L } from "@/lib/triggers/comment-limits";
import { formatDateTime, inputClass, Pill } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "./parts";
import { BACKTRACK_STATUS, jsonInit, requestJson } from "./shared";

interface BacktrackRun {
  id: string;
  days: number;
  status: string;
  scanned: number;
  queued: number;
  skippedDuplicate: number;
  skippedNoMatch: number;
  skippedExpired: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export default function BacktrackSection({
  campaignId,
  active,
  dirty,
}: {
  campaignId: string | null;
  active: boolean;
  dirty: boolean;
}) {
  const [days, setDays] = useState(3);
  const [runs, setRuns] = useState<BacktrackRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!campaignId) return;
    const mine = ++seq.current;
    const res = await requestJson<{ runs: BacktrackRun[] }>(`/api/developer/comments/campaigns/${campaignId}/backtrack`);
    if (mine !== seq.current) return;
    if (res.ok) setRuns(res.data.runs);
    else setError(res.error);
  }, [campaignId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const running = runs?.some((r) => r.status === "RUNNING") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [running, load]);

  async function start() {
    if (!campaignId) return;
    setStarting(true);
    setError(null);
    try {
      const res = await requestJson<{ runId: string }>(
        `/api/developer/comments/campaigns/${campaignId}/backtrack`,
        jsonInit("POST", { days })
      );
      if (!res.ok) setError(res.error);
      await load();
    } finally {
      setStarting(false);
    }
  }

  if (!campaignId) {
    return <Notice tone="info">Avval kampaniyani saqlang — keyin eski kommentlarni skanerlash mumkin bo&apos;ladi.</Notice>;
  }

  return (
    <div className="space-y-3">
      <Notice tone="info">
        Meta faqat <b>7 kun</b> ichida yozilgan kommentga shaxsiy javob yuborishga ruxsat beradi. Tizim tanlangan davrdagi
        kommentlarni tekshiradi: allaqachon javob olganlar, takrorlar va mos kelmaganlar o&apos;tkazib yuboriladi, qolganlari
        navbatga qo&apos;shiladi.
      </Notice>
      {!active && <Notice tone="warning">Kampaniya o&apos;chiq — avval uni yoqing, aks holda navbatdagi kommentlarga javob ketmaydi.</Notice>}
      {dirty && <Notice tone="warning">Saqlanmagan o&apos;zgarishlar bor — skan saqlangan sozlamalar bo&apos;yicha ishlaydi.</Notice>}

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-muted">
          <span className="block">Necha kunlik</span>
          <select className={`${inputClass} w-32`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {Array.from({ length: L.backtrackMaxDays }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} kun
              </option>
            ))}
          </select>
        </label>
        <ConfirmButton
          label="Skanerlashni boshlash"
          question={`Oxirgi ${days} kundagi mos kommentlarga DM yuboriladi. Boshlaymizmi?`}
          confirmLabel="Boshlash"
          busy={starting}
          disabled={running || !active}
          onConfirm={() => void start()}
        />
        {running && <span className="text-xs text-warning">Skan ishlamoqda…</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      {runs === null ? (
        <p className="text-xs text-muted">Yuklanmoqda…</p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted">Hali skan qilinmagan.</p>
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => {
            const status = BACKTRACK_STATUS[run.status] ?? { label: run.status, tone: "muted" as const };
            return (
              <li key={run.id} className="rounded-lg border border-border p-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-foreground">
                    {formatDateTime(run.startedAt)} · {run.days} kun
                  </span>
                  <Pill tone={status.tone}>{status.label}</Pill>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-muted">
                  <span>Tekshirildi: <b className="text-foreground">{run.scanned}</b></span>
                  <span>Navbatga: <b className="text-success">{run.queued}</b></span>
                  <span>Takror / javob olgan: <b>{run.skippedDuplicate}</b></span>
                  <span>Mos emas: <b>{run.skippedNoMatch}</b></span>
                  <span>Muddati o&apos;tgan: <b>{run.skippedExpired}</b></span>
                </div>
                {run.error && <p className="mt-1 text-error">{run.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
