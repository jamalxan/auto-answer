"use client";

/**
 * Trigger engine logs: who wrote, where it came from (story, mention, ad,
 * ig.me link, reaction), what they wrote, what the engine did and how it
 * ended. A row opens the full detail — the readable reason for the admin and
 * the technical detail behind it.
 *
 * Reactions (MESSAGE_REACTION) are stored in observation mode: nothing is
 * answered, the row exists so a real story reaction can be inspected before
 * any automation is built on it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  displayStatus,
  EVENT_FILTER_LABELS,
  EVENT_TYPE_LABELS,
  reactionAction,
  referralLabel,
  shortStoryId,
} from "@/lib/triggers/display";
import { EmptyState, formatDateTime, inputClass, Pill, secondaryButton } from "@/components/developer/ui";

interface Execution {
  id: string;
  status: string;
  matchedKeyword: string | null;
  error: string | null;
  attempts: number;
  nextRetryAt: string | null;
  sentAt: string | null;
  campaign: { id: string; name: string };
}

interface EventRow {
  id: string;
  eventType: string;
  senderId: string;
  senderUsername: string | null;
  storyId: string | null;
  storyUrl: string | null;
  text: string;
  referralSource: string | null;
  adId: string | null;
  ref: string | null;
  reaction: string | null;
  reactedMid: string | null;
  timestamp: string;
  processingStatus: string;
  error: string | null;
  attempts: number;
  createdAt: string;
  instagramAccount: { username: string };
  contact: { id: string; username: string | null; name: string | null } | null;
  executions: Execution[];
}

interface DetailExecution extends Execution {
  errorDetail: string | null;
  responseText: string;
  sentMessageId: string | null;
}

interface Detail {
  event: Omit<EventRow, "executions"> & {
    messageId: string;
    errorDetail: string | null;
    rawPayload: unknown;
    processedAt: string | null;
    executions: DetailExecution[];
  };
  messages: Array<{ id: string; direction: string; text: string; createdAt: string }>;
}

const STATUS_FILTERS: Array<[string, string]> = [
  ["", "Barchasi"],
  ["PROCESSED", "Qayta ishlangan"],
  ["IGNORED", "E'tiborsiz"],
  ["RETRYING", "Qayta yuboriladi"],
  ["FAILED", "Xato"],
  ["PENDING", "Navbatda"],
];

function who(event: EventRow): string {
  const username = event.contact?.username ?? event.senderUsername;
  return username ? `@${username}` : `id ${event.senderId.slice(-6)}`;
}

/** Where the event came from, in a few words: the "Manba" column. */
function sourceText(event: EventRow): string {
  switch (event.eventType) {
    case "STORY_REPLY":
      return `Story ${shortStoryId(event.storyId)}`;
    case "STORY_MENTION":
      return "Story mention";
    case "MESSAGE_REACTION":
      return "Reaksiya · kuzatuv";
    case "DIRECT_MESSAGE":
      return referralLabel(event) ?? "Direct";
    default:
      return EVENT_TYPE_LABELS[event.eventType] ?? event.eventType;
  }
}

/** Reactions carry no text: the emoji and what happened to it. */
function eventText(event: EventRow, rawPayload?: unknown): string {
  if (event.eventType === "MESSAGE_REACTION") {
    // The engine stores the action (react / unreact) as the event text.
    const action = event.text || (rawPayload ? reactionAction(rawPayload) : null);
    return `${event.reaction ?? "?"}${action === "unreact" ? " (olib tashlandi)" : ""}`;
  }
  if (event.eventType === "STORY_MENTION" && !event.text) return "Story'da belgiladi";
  return event.text || "—";
}

function ErrorCard({ event }: { event: EventRow }) {
  const status = displayStatus(event);
  if (status.key !== "FAILED" && status.key !== "RETRYING") return null;
  const execution = event.executions[event.executions.length - 1];
  const reason = execution?.error ?? event.error ?? "Noma'lum xato";
  return (
    <div className="rounded-lg border border-error/30 bg-error/5 px-3 py-2 text-sm">
      <p className="font-semibold text-error">❌ Message yuborilmadi</p>
      <p className="mt-1 text-foreground">
        <span className="text-muted">Sabab: </span>
        {reason}
      </p>
      <p className="mt-1 text-foreground">
        <span className="text-muted">Status: </span>
        {status.key === "RETRYING"
          ? `Queued for retry${execution?.nextRetryAt ? ` · ${formatDateTime(execution.nextRetryAt)}` : ""}`
          : "Failed"}
      </p>
    </div>
  );
}

function DetailPanel({
  id,
  onClose,
  onRetried,
}: {
  id: string;
  onClose: () => void;
  onRetried: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/triggers/events/${id}`);
      const data = await res.json();
      if (data.success) {
        setDetail(data.data);
        setError(null);
      } else setError(data.error ?? "Yuklab bo'lmadi");
    } catch {
      setError("Yuklab bo'lmadi");
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on open
    void load();
  }, [load]);

  async function retry() {
    setRetrying(true);
    let data: { success?: boolean; error?: string } | null = null;
    try {
      const res = await fetch(`/api/triggers/events/${id}/retry`, { method: "POST" });
      data = await res.json();
    } catch {
      data = null;
    } finally {
      setRetrying(false);
    }
    if (!data?.success) {
      setError(data?.error ?? "Qayta yuborib bo'lmadi");
      return;
    }
    onRetried();
    await load();
  }

  const event = detail?.event;
  const canRetry = event && (event.processingStatus === "FAILED" || event.processingStatus === "IGNORED");

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="h-full w-full max-w-xl overflow-y-auto border-l border-border bg-background p-4 sm:p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Event tafsilotlari"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">Event tafsilotlari</h2>
          <button type="button" onClick={onClose} className={secondaryButton}>
            Yopish
          </button>
        </div>

        {error && <p className="mb-3 text-sm text-error">{error}</p>}
        {!event ? (
          !error && <p className="text-sm text-muted">Yuklanmoqda…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={displayStatus(event).tone}>{displayStatus(event).label}</Pill>
              <span className="text-muted">{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</span>
              <span className="text-muted">· @{event.instagramAccount.username}</span>
            </div>

            <ErrorCard event={event} />
            {event.eventType === "MESSAGE_REACTION" && (
              <p className="rounded-lg border border-border px-3 py-2 text-muted">
                Kuzatuv rejimi: reaksiyalarga javob yuborilmaydi. Meta story reaksiyasi shu ko&apos;rinishda kelishini hali
                tasdiqlamagan — pastdagi raw payload&apos;ni tekshirib ko&apos;ring.
              </p>
            )}
            {event.processingStatus === "IGNORED" && event.error && (
              <p className="rounded-lg border border-border px-3 py-2 text-muted">Sabab: {event.error}</p>
            )}

            <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-muted">Kim</dt>
              <dd className="break-all text-foreground">
                {who(event)} {event.contact?.name ? `(${event.contact.name})` : ""}
              </dd>
              <dt className="text-muted">Sender ID</dt>
              <dd className="break-all font-mono text-xs text-foreground">{event.senderId}</dd>
              {(event.storyId || event.storyUrl) && (
                <>
                  <dt className="text-muted">Story</dt>
                  <dd className="break-all text-foreground">
                    {event.storyId ?? (event.eventType === "STORY_MENTION" ? "mention" : "—")}
                    {event.storyUrl && (
                      <a href={event.storyUrl} target="_blank" rel="noreferrer" className="ml-2 text-accent">
                        ochish
                      </a>
                    )}
                  </dd>
                </>
              )}
              {referralLabel(event) && (
                <>
                  <dt className="text-muted">Manba</dt>
                  <dd className="break-all text-foreground">
                    {referralLabel(event)}
                    {event.referralSource && <span className="ml-2 text-xs text-muted">source: {event.referralSource}</span>}
                  </dd>
                </>
              )}
              {event.eventType === "MESSAGE_REACTION" ? (
                <>
                  <dt className="text-muted">Reaksiya</dt>
                  <dd className="text-foreground">
                    {event.reaction ?? "—"} · {event.text || reactionAction(event.rawPayload) || "react"}
                  </dd>
                  <dt className="text-muted">Qaysi xabarga</dt>
                  <dd className="break-all font-mono text-xs text-foreground">{event.reactedMid ?? "—"}</dd>
                </>
              ) : (
                <>
                  <dt className="text-muted">Matn</dt>
                  <dd className="whitespace-pre-wrap break-words text-foreground">{event.text || "— (matnsiz)"}</dd>
                </>
              )}
              <dt className="text-muted">Message ID</dt>
              <dd className="break-all font-mono text-xs text-foreground">{event.messageId}</dd>
              <dt className="text-muted">Vaqt</dt>
              <dd className="text-foreground">
                {formatDateTime(event.timestamp)} · qabul: {formatDateTime(event.createdAt)}
              </dd>
              <dt className="text-muted">Urinishlar</dt>
              <dd className="text-foreground">{event.attempts}</dd>
            </dl>

            {event.executions.map((execution) => (
              <div key={execution.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-foreground">Campaign: {execution.campaign.name}</p>
                  <span className="label-mono text-[11px] text-muted">{execution.status}</span>
                </div>
                {execution.matchedKeyword && (
                  <p className="mt-1 text-muted">Kalit so&apos;z: {execution.matchedKeyword}</p>
                )}
                <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-surface-hover px-2 py-1.5 text-foreground">
                  {execution.responseText}
                </p>
                <p className="mt-2 text-xs text-muted">
                  Urinishlar: {execution.attempts}
                  {execution.sentAt && ` · yuborildi ${formatDateTime(execution.sentAt)}`}
                  {execution.sentMessageId && ` · mid ${execution.sentMessageId.slice(-10)}`}
                </p>
                {execution.errorDetail && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-hover p-2 font-mono text-[11px] text-muted">
                    {execution.errorDetail}
                  </pre>
                )}
              </div>
            ))}

            {event.errorDetail && !event.executions.some((e) => e.errorDetail) && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-hover p-2 font-mono text-[11px] text-muted">
                {event.errorDetail}
              </pre>
            )}

            {canRetry && (
              <button type="button" onClick={retry} disabled={retrying} className={secondaryButton}>
                {retrying ? "Navbatga qo'yilmoqda…" : "Qayta ishlash"}
              </button>
            )}

            {detail.messages.length > 0 && (
              <div>
                <p className="label-mono mb-2 text-[11px] font-semibold text-muted">Suhbat</p>
                <div className="space-y-2">
                  {detail.messages.map((m) => (
                    <div key={m.id} className={`flex ${m.direction === "OUTBOUND" ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 ${
                          m.direction === "OUTBOUND" ? "bg-accent/20" : "bg-surface-hover"
                        }`}
                      >
                        {m.text || "—"}
                        <span className="mt-0.5 block text-[10px] text-muted">{formatDateTime(m.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <details>
              <summary className="cursor-pointer text-muted">Raw payload</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-hover p-2 font-mono text-[11px] text-muted">
                {JSON.stringify(event.rawPayload, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TriggerLogs({
  campaigns,
  initialCampaignId = "",
  initialType,
}: {
  campaigns: Array<{ id: string; name: string }>;
  initialCampaignId?: string;
  /** Event type (or REFERRAL_ADS / REFERRAL_LINK) to filter by from the start. */
  initialType?: string | null;
}) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [type, setType] = useState(initialType && initialType in EVENT_FILTER_LABELS ? initialType : "");
  const [campaignId, setCampaignId] = useState(initialCampaignId);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  // Filters change while a request is in flight (typing in search); only the
  // newest request may update the list.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    if (campaignId) params.set("campaignId", campaignId);
    if (q.trim()) params.set("q", q.trim());
    try {
      const res = await fetch(`/api/triggers/events?${params}`);
      const data = await res.json();
      if (seq !== loadSeq.current) return;
      if (data.success) {
        setEvents(data.data.events);
        setTotalPages(data.data.pagination.totalPages);
      }
    } catch {
      // keep what is shown; the next poll tries again
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [page, status, type, campaignId, q]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after the fetch resolves
    void load();
    // Live-ish: events arrive from webhooks while the page is open.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-4">
        <select className={inputClass} value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">Barcha eventlar</option>
          {Object.entries(EVENT_FILTER_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUS_FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select className={inputClass} value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setPage(1); }}>
          <option value="">Barcha campaignlar</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="@username, matn, story / reklama ID, ref"
        />
      </div>

      <div className="panel overflow-hidden rounded-xl">
        {loading ? (
          <p className="px-4 py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : events.length === 0 ? (
          <EmptyState
            title="Hali event yo'q"
            body={
              type === "MESSAGE_REACTION"
                ? "Kimdir xabaringizga (yoki story'ga) reaksiya bildirsa, shu yerda kuzatuv uchun ko'rinadi."
                : "Direct, story, mention yoki reklama xabari kelganda shu yerda ko'rinadi."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-border text-xs text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">Manba</th>
                  <th className="px-4 py-2.5 font-medium">Matn</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Vaqt</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const s = displayStatus(event);
                  const execution = event.executions[event.executions.length - 1];
                  return (
                    <tr
                      key={event.id}
                      onClick={() => setOpenId(event.id)}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-hover"
                    >
                      <td className="px-4 py-2.5 font-medium text-foreground">{who(event)}</td>
                      <td className="px-4 py-2.5 text-muted">{sourceText(event)}</td>
                      <td className="max-w-[16rem] truncate px-4 py-2.5 text-foreground" title={event.text}>
                        {eventText(event)}
                      </td>
                      <td className="px-4 py-2.5 text-muted">
                        {execution ? (
                          <span title={execution.campaign.name}>DM · {execution.campaign.name}</span>
                        ) : event.eventType === "MESSAGE_REACTION" ? (
                          "Kuzatuv (javobsiz)"
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col gap-1">
                          <Pill tone={s.tone}>{s.label}</Pill>
                          {(s.key === "FAILED" || s.key === "RETRYING" || s.key === "IGNORED") && (
                            <span className="max-w-[14rem] truncate text-xs text-muted" title={execution?.error ?? event.error ?? ""}>
                              {execution?.error ?? event.error}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted">{formatDateTime(event.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button type="button" className={secondaryButton} disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Oldingi
          </button>
          <span className="text-muted">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            className={secondaryButton}
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Keyingi
          </button>
        </div>
      )}

      {openId && <DetailPanel id={openId} onClose={() => setOpenId(null)} onRetried={() => void load()} />}
    </div>
  );
}
