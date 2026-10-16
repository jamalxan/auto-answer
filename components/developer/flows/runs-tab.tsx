"use client";

/**
 * Runs: people currently going through this flow (live table, refreshed
 * every few seconds while the tab is open), status filter, run detail with
 * its step log, and cancel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { EmptyState, formatDateTime, Pill, secondaryButton } from "@/components/developer/ui";
import { FLOWS_API, jsonInit, requestJson, RUN_STATUS_TEXT, valueText } from "./shared";

interface RunRow {
  id: string;
  status: string;
  igUserId?: string;
  username?: string | null;
  contactName?: string | null;
  contact?: { username?: string | null; name?: string | null } | null;
  versionNumber?: number | null;
  version?: { version?: number } | number | null;
  currentNodeId?: string | null;
  waitNodeId?: string | null;
  waitKind?: string | null;
  waitUntil?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  endReason?: string | null;
  lastError?: string | null;
  isTest?: boolean;
}

interface RunDetail extends RunRow {
  steps?: Array<{ seq?: number; nodeId: string; nodeType?: string; status?: string; reason?: string | null; input?: unknown; output?: unknown; startedAt?: string }>;
  variables?: Record<string, unknown>;
}

interface RunPage {
  items?: RunRow[];
  runs?: RunRow[];
  nextCursor?: string | null;
}

const FILTERS: Array<[string, string]> = [
  ["", "Hammasi"],
  ["ACTIVE", "Ishlayapti"],
  ["WAITING_TAP", "Tugma kutilmoqda"],
  ["WAITING_INBOUND", "Javob kutilmoqda"],
  ["WAITING_DELAY", "Kutish"],
  ["DONE", "Tugagan"],
  ["FAILED", "Xato"],
  ["CANCELLED", "Bekor qilingan"],
];

const STEP_TONE: Record<string, "success" | "warning" | "error" | "muted"> = { DONE: "success", WAITING: "warning", FAILED: "error", SKIPPED: "muted" };
const POLL_MS = 10_000;

function who(run: RunRow): string {
  const username = run.contact?.username ?? run.username;
  const name = run.contact?.name ?? run.contactName;
  return username ? `@${username}` : (name ?? run.igUserId ?? run.id.slice(-6));
}

function versionOf(run: RunRow): string {
  const v = typeof run.version === "number" ? run.version : (run.version?.version ?? run.versionNumber);
  return v ? `v${v}` : "—";
}

export default function RunsTab({ flowId, canWrite }: { flowId: string; canWrite: boolean }) {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const seq = useRef(0);
  const detailSeq = useRef(0);

  const load = useCallback(
    async (cursor?: string | null) => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const q = new URLSearchParams({ limit: "25" });
        if (status) q.set("status", status);
        if (cursor) q.set("cursor", cursor);
        const res = await requestJson<RunPage>(`${FLOWS_API}/${flowId}/runs?${q.toString()}`);
        if (mine !== seq.current) return;
        if (res.ok) {
          const items = res.data.items ?? res.data.runs ?? [];
          setRows((prev) => (cursor && prev ? [...prev, ...items] : items));
          setNext(res.data.nextCursor ?? null);
          setError(null);
        } else setError(res.error);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [flowId, status]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial / filter fetch
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const counter = seq;
    return () => {
      window.clearInterval(timer);
      counter.current++;
    };
  }, [load]);

  async function open(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    const mine = ++detailSeq.current;
    setOpenId(id);
    setDetail(null);
    setDetailBusy(true);
    try {
      const res = await requestJson<RunDetail | { run: RunDetail; steps?: RunDetail["steps"] }>(`${FLOWS_API}/${flowId}/runs/${id}`);
      if (mine !== detailSeq.current) return;
      if (res.ok) {
        const data = res.data as { run?: RunDetail; steps?: RunDetail["steps"] } & RunDetail;
        setDetail(data.run ? { ...data.run, steps: data.steps ?? data.run.steps } : data);
      } else setError(res.error);
    } finally {
      if (mine === detailSeq.current) setDetailBusy(false);
    }
  }

  async function cancel(id: string) {
    setCancelBusy(id);
    setError(null);
    try {
      const res = await requestJson<unknown>(`${FLOWS_API}/${flowId}/runs/${id}/cancel`, jsonInit("POST", {}));
      if (res.ok) await load();
      else setError(res.error);
    } finally {
      setCancelBusy(null);
    }
  }

  const live = (s: string) => s === "ACTIVE" || s.startsWith("WAITING");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-muted">
          Holat
          <select className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground" value={status} onChange={(e) => setStatus(e.target.value)}>
            {FILTERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
          {loading ? "Yangilanmoqda…" : "Yangilash"}
        </button>
        <span className="text-xs text-muted">Har {POLL_MS / 1000} soniyada avtomatik yangilanadi</span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!rows ? (
        <p className="py-8 text-center text-sm text-muted">{loading ? "Yuklanmoqda…" : ""}</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Hali ishga tushishlar yo'q" body="Oqim ishga tushirilgach, har bir mijoz shu yerda ko'rinadi." />
      ) : (
        <ul className="space-y-2">
          {rows.map((run) => {
            const st = RUN_STATUS_TEXT[run.status] ?? { label: run.status, tone: "muted" as const };
            const expanded = openId === run.id;
            return (
              <li key={run.id} className="panel rounded-xl">
                <div className="flex flex-wrap items-center gap-2 p-3">
                  <button type="button" aria-expanded={expanded} onClick={() => void open(run.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left">
                    <span className="text-sm font-semibold text-foreground">{who(run)}</span>
                    <Pill tone={st.tone}>{st.label}</Pill>
                    <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[11px] text-muted">{versionOf(run)}</span>
                    {run.isTest && <span className="rounded-md bg-gold/15 px-1.5 py-0.5 text-[11px] text-gold">test</span>}
                    {(run.waitNodeId || run.currentNodeId) && <span className="label-mono text-[10px] text-muted">{run.waitNodeId ?? run.currentNodeId}</span>}
                    <span className="ml-auto text-xs text-muted">{formatDateTime(run.startedAt)}</span>
                  </button>
                  {canWrite && live(run.status) && (
                    <ConfirmButton label="Bekor qilish" question="Bu mijoz uchun oqim to'xtatilsinmi?" confirmLabel="Bekor qilish" danger busy={cancelBusy === run.id} disabled={cancelBusy !== null} onConfirm={() => void cancel(run.id)} />
                  )}
                </div>
                {run.waitUntil && live(run.status) && <p className="px-3 pb-2 text-xs text-muted">Kutish tugaydi: {formatDateTime(run.waitUntil)}</p>}
                {(run.lastError || run.endReason) && <p className="px-3 pb-2 text-xs text-muted">{run.lastError ?? run.endReason}</p>}
                {expanded && (
                  <div className="border-t border-border p-3">
                    {detailBusy && <p className="text-sm text-muted">Yuklanmoqda…</p>}
                    {detail && (
                      <div className="space-y-3">
                        <ol className="space-y-1.5" aria-label="Qadamlar">
                          {(detail.steps ?? []).length === 0 && <li className="text-sm text-muted">Qadamlar yo&apos;q.</li>}
                          {(detail.steps ?? []).map((step, i) => (
                            <li key={`${step.seq ?? i}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm">
                              <span className="label-mono w-6 text-[10px] text-muted">{i + 1}</span>
                              <span className="font-medium text-foreground">{step.nodeId}</span>
                              {step.nodeType && <span className="text-xs text-muted">{step.nodeType}</span>}
                              <Pill tone={STEP_TONE[step.status ?? ""] ?? "muted"}>{step.status ?? "—"}</Pill>
                              {step.reason && <span className="min-w-0 break-words text-xs text-muted">{step.reason}</span>}
                              {step.startedAt && <span className="ml-auto text-[11px] text-muted">{formatDateTime(step.startedAt)}</span>}
                            </li>
                          ))}
                        </ol>
                        {detail.variables && Object.keys(detail.variables).length > 0 && (
                          <p className="break-words text-xs text-muted">O&apos;zgaruvchilar: {valueText(detail.variables)}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load(next)}>
          {loading ? "Yuklanmoqda…" : "Yana yuklash"}
        </button>
      )}
    </div>
  );
}
