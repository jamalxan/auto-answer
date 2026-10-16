"use client";

/**
 * Live participants of one giveaway: status pill, per-rule checks, reason,
 * follow result, tagged handles, comment time. Filters by status and text,
 * cursor paging, and the manual actions: accept / reject a PENDING_CHECK
 * entry, disqualify with a written reason (inline, no window.prompt).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Pill, formatDateTime, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import {
  CHECK_LABELS,
  ENGAGEMENT_API,
  ENTRY_STATUS,
  FOLLOW_RESULT,
  jsonInit,
  requestJson,
  type EntryRow,
  type EntryStatus,
  type GiveawayStatus,
} from "./shared";

interface Page {
  entries: EntryRow[];
  nextCursor: string | null;
  counts: Record<EntryStatus, number>;
}

const FILTERS: Array<[EntryStatus | "", string]> = [
  ["", "Hammasi"],
  ["ELIGIBLE", "Qabul qilindi"],
  ["PENDING_CHECK", "Tekshirilmoqda"],
  ["INELIGIBLE", "Mos emas"],
  ["WINNER", "G'oliblar"],
  ["DISQUALIFIED", "Chetlatilgan"],
];

type Pending = { entryId: string; action: "mark-ineligible" | "disqualify" };

export default function EntriesTable({
  giveawayId,
  giveawayStatus,
  canManage,
  refreshKey,
  onChanged,
}: {
  giveawayId: string;
  giveawayStatus: GiveawayStatus;
  canManage: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<EntryStatus | "">("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [entries, setEntries] = useState<EntryRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<EntryStatus, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (after: string | null) => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (status) params.set("status", status);
        if (debouncedQ) params.set("q", debouncedQ);
        if (after) params.set("cursor", after);
        const res = await requestJson<Page>(`${ENGAGEMENT_API}/giveaways/${giveawayId}/entries?${params}`);
        if (mine !== seq.current) return;
        if (res.ok) {
          setEntries((prev) => (after && prev ? [...prev, ...res.data.entries] : res.data.entries));
          setCursor(res.data.nextCursor);
          setCounts(res.data.counts);
        } else setError(res.error);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [giveawayId, status, debouncedQ]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter / refresh change
    void load(null);
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load, refreshKey]);

  async function act(entry: EntryRow, action: "mark-eligible" | "mark-ineligible" | "disqualify", text?: string) {
    setBusyId(entry.id);
    setError(null);
    try {
      const res = await requestJson(
        `${ENGAGEMENT_API}/giveaways/${giveawayId}/entries/${entry.id}`,
        jsonInit("PATCH", { action, reason: text?.trim() || undefined })
      );
      if (res.ok) {
        setPending(null);
        setReason("");
        onChanged();
        void load(null);
      } else setError(res.error);
    } finally {
      setBusyId(null);
    }
  }

  const canMark = canManage && (giveawayStatus === "ACTIVE" || giveawayStatus === "CLOSED");
  const canDisqualify = canManage && (giveawayStatus === "CLOSED" || giveawayStatus === "DRAWN");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Holat bo'yicha filtr">
        {FILTERS.map(([key, label]) => {
          const n = key ? counts?.[key] : counts ? Object.values(counts).reduce((a, b) => a + b, 0) : undefined;
          return (
            <button
              key={key || "all"}
              type="button"
              aria-pressed={status === key}
              onClick={() => setStatus(key)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${status === key ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"}`}
            >
              {label}
              {n !== undefined ? ` · ${n}` : ""}
            </button>
          );
        })}
      </div>
      <input
        className={inputClass}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Username yoki izoh bo'yicha qidirish"
        aria-label="Ishtirokchilarni qidirish"
      />
      {error && <Notice tone="error">{error}</Notice>}

      {entries === null ? (
        <p className="py-6 text-center text-sm text-muted">{loading ? "Yuklanmoqda…" : ""}</p>
      ) : entries.length === 0 ? (
        <EmptyState
          title={status || debouncedQ ? "Bu filtrga mos ishtirokchi yo'q" : "Hali ishtirokchi yo'q"}
          body={status || debouncedQ ? undefined : "Post ostida izoh qoldirganlar bir daqiqa ichida shu yerda paydo bo'ladi."}
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {entries.map((entry) => {
            const st = ENTRY_STATUS[entry.status];
            const follow = FOLLOW_RESULT[entry.followResult];
            const reasonText = entry.disqualifyReason ?? entry.ineligibleReason;
            const checkKeys = Object.keys(entry.checks ?? {}).filter((k) => k in CHECK_LABELS);
            const isPending = pending?.entryId === entry.id ? pending : null;
            return (
              <li key={entry.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all text-sm font-semibold text-foreground">{entry.username ? `@${entry.username}` : entry.igUserId}</span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                  {entry.followResult !== "NOT_CHECKED" && <Pill tone={follow.tone}>{follow.label}</Pill>}
                  <span className="ml-auto text-xs text-muted">{formatDateTime(entry.firstCommentAt)}</span>
                </div>
                <p className="break-words text-sm text-muted">{entry.firstCommentText || "—"}</p>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {checkKeys.map((key) => {
                    const check = entry.checks?.[key];
                    return (
                      <span key={key} title={check?.detail} className={`rounded-md px-1.5 py-0.5 ring-1 ring-inset ${check?.passed ? "text-success ring-success/30" : "text-error ring-error/30"}`}>
                        {CHECK_LABELS[key]} {check?.passed ? "✓" : "✗"}
                      </span>
                    );
                  })}
                  {entry.taggedUsernames.length > 0 && <span className="break-all text-muted">Belgilangan: {entry.taggedUsernames.map((u) => `@${u}`).join(", ")}</span>}
                  {entry.commentCount > 1 && <span className="text-muted">{entry.commentCount} ta izoh (bitta ishtirok)</span>}
                </div>
                {reasonText && <p className="text-xs text-muted">Sabab: {reasonText}</p>}

                {canMark && entry.status === "PENDING_CHECK" && !isPending && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={secondaryButton} disabled={busyId === entry.id} onClick={() => void act(entry, "mark-eligible")}>
                      Qabul qilish
                    </button>
                    <button type="button" className={secondaryButton} disabled={busyId === entry.id} onClick={() => { setPending({ entryId: entry.id, action: "mark-ineligible" }); setReason(""); }}>
                      Rad etish
                    </button>
                  </div>
                )}
                {canDisqualify && (entry.status === "WINNER" || entry.status === "ELIGIBLE") && !isPending && (
                  <button type="button" className="text-xs font-medium text-error hover:underline" onClick={() => { setPending({ entryId: entry.id, action: "disqualify" }); setReason(""); }}>
                    Chetlatish…
                  </button>
                )}
                {isPending && (
                  <div className="space-y-2 rounded-lg border border-border p-3">
                    <label className="block text-xs font-semibold text-muted" htmlFor={`reason-${entry.id}`}>
                      {isPending.action === "disqualify" ? "Chetlatish sababi (jurnalga yoziladi)" : "Rad etish sababi"}
                    </label>
                    <input id={`reason-${entry.id}`} className={inputClass} value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Masalan: soxta akkaunt" />
                    {isPending.action === "disqualify" && entry.status === "WINNER" && (
                      <p className="text-xs text-muted">G&apos;olibni chetlatsangiz joriy qur&apos;a bekor qilinadi va YANGI commitment bilan qayta tashlanadi.</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={primaryButton} disabled={busyId === entry.id || !reason.trim()} onClick={() => void act(entry, isPending.action, reason)}>
                        {busyId === entry.id ? "Kuting…" : "Tasdiqlash"}
                      </button>
                      <button type="button" className={secondaryButton} onClick={() => setPending(null)}>
                        Bekor
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <div className="text-center">
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load(cursor)}>
            {loading ? "Yuklanmoqda…" : "Yana yuklash"}
          </button>
        </div>
      )}
    </div>
  );
}
