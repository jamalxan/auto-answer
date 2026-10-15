"use client";

/**
 * One campaign's executions, newest first: the comment, what was sent (and
 * which variant), the public reply, whether the window opened, lead /
 * handoff, and every follow-up with its state. Scheduled follow-ups can be
 * cancelled from here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EXECUTION_STATUSES } from "@/lib/triggers/comment-limits";
import { EmptyState, formatDateTime, Pill, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "./parts";
import { EXECUTION_STATUS, FOLLOW_UP_CONDITION_TEXT, FOLLOW_UP_STATUS, formatDelay, requestJson } from "./shared";

interface FollowUpRun {
  id: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  reason: string | null;
  step: { sort: number; delayMinutes: number; condition: string };
}

interface ExecutionRow {
  id: string;
  status: string;
  matchedKeyword: string | null;
  responseText: string;
  error: string | null;
  attempts: number;
  nextRetryAt: string | null;
  sentAt: string | null;
  createdAt: string;
  publicReplyStatus: string | null;
  publicReplyError: string | null;
  openedAt: string | null;
  lastInboundAt: string | null;
  leadCapturedAt: string | null;
  handedOffAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  variant: { id: string; kind: string; text: string; source: string } | null;
  event: {
    id: string;
    text: string;
    senderId: string;
    senderUsername: string | null;
    mediaId: string | null;
    timestamp: string;
    backtrackRunId: string | null;
    contact: { username: string | null; name: string | null; phone: string | null; email: string | null } | null;
  };
  followUps: FollowUpRun[];
}

interface LogsResponse {
  executions: ExecutionRow[];
  pagination: { page: number; totalPages: number; total: number };
}

function ExecutionCard({ row, onChanged }: { row: ExecutionRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const status = EXECUTION_STATUS[row.status] ?? { label: row.status, tone: "muted" as const };
  const who = row.event.contact?.username ?? row.event.senderUsername;
  const scheduled = row.followUps.filter((f) => f.status === "SCHEDULED").length;

  async function cancel() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await requestJson<{ cancelled: number }>(`/api/developer/comments/executions/${row.id}/cancel-follow-ups`, {
        method: "POST",
      });
      if (!res.ok) setMessage({ tone: "error", text: res.error });
      else {
        setMessage({ tone: "info", text: `${res.data.cancelled} ta follow-up bekor qilindi` });
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="panel space-y-2 rounded-xl p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground">
            {who ? `@${who}` : `id …${row.event.senderId.slice(-6)}`}
            <span className="ml-2 text-xs font-normal text-muted">{formatDateTime(row.event.timestamp)}</span>
          </p>
          <p className="mt-0.5 break-words text-muted">“{row.event.text || "—"}”</p>
        </div>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {row.matchedKeyword && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-foreground">🔑 {row.matchedKeyword}</span>}
        {row.event.mediaId && <span className="rounded bg-surface-hover px-1.5 py-0.5 text-muted">Post #{row.event.mediaId.slice(-6)}</span>}
        {row.event.backtrackRunId && <span className="rounded bg-surface-hover px-1.5 py-0.5 text-muted">Eski komment</span>}
        {row.publicReplyStatus && (
          <span className={`rounded px-1.5 py-0.5 ${row.publicReplyStatus === "SENT" ? "bg-success/10 text-success" : "bg-error/10 text-error"}`}>
            Ochiq javob: {row.publicReplyStatus === "SENT" ? "yozildi" : "xato"}
          </span>
        )}
        {row.openedAt && <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">Tugma bosildi {formatDateTime(row.openedAt)}</span>}
        {row.leadCapturedAt && (
          <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">
            Lead{row.event.contact?.phone ? `: ${row.event.contact.phone}` : ""}
          </span>
        )}
        {row.handedOffAt && <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">Operatorga o&apos;tdi</span>}
        {row.stoppedAt && (
          <span className="rounded bg-surface-hover px-1.5 py-0.5 text-muted">To&apos;xtadi: {row.stopReason ?? "—"}</span>
        )}
      </div>

      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted hover:text-foreground">
          Yuborilgan DM{row.variant ? ` · ${row.variant.source === "AI" ? "AI " : ""}variant` : " · zaxira matn"}
        </summary>
        <p className="whitespace-pre-wrap break-words border-t border-border px-2.5 py-2 text-foreground">{row.responseText}</p>
      </details>

      {(row.error || row.publicReplyError) && (
        <Notice tone="error">
          {row.error && <span className="block">{row.error}</span>}
          {row.publicReplyError && <span className="block">Ochiq javob: {row.publicReplyError}</span>}
          {row.nextRetryAt && <span className="block text-muted">Keyingi urinish: {formatDateTime(row.nextRetryAt)}</span>}
        </Notice>
      )}

      {row.followUps.length > 0 && (
        <div className="space-y-1.5">
          <p className="label-mono text-[10px] text-muted">Follow-up</p>
          <ul className="space-y-1">
            {row.followUps.map((run) => {
              const s = FOLLOW_UP_STATUS[run.status] ?? { label: run.status, tone: "muted" as const };
              return (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
                  <span className="min-w-0 text-muted">
                    <b className="text-foreground">{run.step.sort + 1}</b> · +{formatDelay(run.step.delayMinutes)} ·{" "}
                    {FOLLOW_UP_CONDITION_TEXT[run.step.condition as keyof typeof FOLLOW_UP_CONDITION_TEXT] ?? run.step.condition} ·{" "}
                    {run.sentAt ? `yuborildi ${formatDateTime(run.sentAt)}` : `reja ${formatDateTime(run.scheduledAt)}`}
                    {run.reason && <span className="block break-words">{run.reason}</span>}
                  </span>
                  <Pill tone={s.tone}>{s.label}</Pill>
                </li>
              );
            })}
          </ul>
          {scheduled > 0 && (
            <ConfirmButton
              label={`Follow-uplarni bekor qilish (${scheduled})`}
              question="Rejadagi follow-uplar yuborilmaydi. Davom etamizmi?"
              confirmLabel="Bekor qilish"
              danger
              busy={busy}
              onConfirm={() => void cancel()}
            />
          )}
        </div>
      )}
      {message && <p className={`text-xs ${message.tone === "error" ? "text-error" : "text-muted"}`}>{message.text}</p>}
    </li>
  );
}

export default function CommentLogs({ campaignId }: { campaignId: string }) {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const query = new URLSearchParams({ page: String(page) });
      if (status) query.set("status", status);
      const res = await requestJson<LogsResponse>(`/api/developer/comments/campaigns/${campaignId}/logs?${query}`);
      if (mine !== seq.current) return;
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else setError(res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [campaignId, page, status]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter / page change
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {["", ...EXECUTION_STATUSES].map((key) => (
          <button
            key={key || "all"}
            type="button"
            aria-pressed={status === key}
            onClick={() => {
              setStatus(key);
              setPage(1);
            }}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              status === key ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {key ? EXECUTION_STATUS[key].label : "Barchasi"}
          </button>
        ))}
        <button type="button" className={`${secondaryButton} ml-auto`} disabled={loading} onClick={() => void load()}>
          {loading ? "Yuklanmoqda…" : "Yangilash"}
        </button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {!data ? (
        !error && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : data.executions.length === 0 ? (
        <div className="panel rounded-xl">
          <EmptyState
            title="Hali log yo'q"
            body="Mos komment kelganda yoki eski kommentlar skanerlanganda shu yerda paydo bo'ladi."
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {data.executions.map((row) => (
            <ExecutionCard key={row.id} row={row} onChanged={() => void load()} />
          ))}
        </ul>
      )}

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button type="button" className={secondaryButton} disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
            Oldingi
          </button>
          <span className="text-muted">
            {page} / {data.pagination.totalPages}
          </span>
          <button
            type="button"
            className={secondaryButton}
            disabled={page >= data.pagination.totalPages || loading}
            onClick={() => setPage(page + 1)}
          >
            Keyingi
          </button>
        </div>
      )}
    </div>
  );
}
