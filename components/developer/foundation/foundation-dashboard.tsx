"use client";

/**
 * ETAP 1 — Foundation, dev console.
 *
 * Tabs: Ulanishlar · Diagnostika · Navbat · Xatolar. One overview call feeds
 * the first three; the error feed loads when its tab opens. Every fetch is
 * tagged with a sequence number so a slow, older response never overwrites a
 * newer one, and loading flags are cleared in `finally`.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionView } from "@/lib/foundation/connections";
import type { DiagnosticItem, DiagnosticStatus } from "@/lib/foundation/diagnostics";
import type { ErrorFeedItem } from "@/lib/foundation/errors-feed";
import type { FoundationOverview } from "@/lib/foundation/overview";
import type { DisplayTone } from "@/lib/triggers/display";
import TestDataTab from "./test-data-tab";
import { DevBadge, EmptyState, formatDateTime, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";

// Same as lib/foundation/error-catalog's RECONNECT_HREF, kept here so this
// client bundle does not pull in the Meta client.
const RECONNECT_HREF = "/api/instagram/connect?return=/developer/foundation";

const TABS = [
  ["connections", "Ulanishlar"],
  ["diagnostics", "Diagnostika"],
  ["queue", "Navbat"],
  ["errors", "Xatolar"],
  ["testdata", "Test ma'lumotlar"],
] as const;
type Tab = (typeof TABS)[number][0];


async function getJson<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) return { ok: false, error: body?.error ?? `So'rov bajarilmadi (${res.status})` };
    return { ok: true, data: body.data as T };
  } catch {
    return { ok: false, error: "Server bilan aloqa yo'q" };
  }
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="panel min-w-0 rounded-xl px-4 py-3">
      <p className="label-mono break-words text-[10px] font-semibold text-muted">{label}</p>
      <p className={`mt-1 break-words text-xl font-bold leading-tight ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
      <span className="min-w-0 break-words">{message}</span>
      {onRetry && (
        <button type="button" className={secondaryButton} onClick={onRetry}>
          Qayta urinish
        </button>
      )}
    </div>
  );
}

// ── Ulanishlar ───────────────────────────────────────────────────────────────

function ConnectionCard({
  connection,
  onChecked,
}: {
  connection: ConnectionView;
  onChecked: (next: ConnectionView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "error" | "muted"; text: string } | null>(null);

  async function recheck() {
    setBusy(true);
    setNote(null);
    try {
      const res = await getJson<{ result: string; connection: ConnectionView }>(
        `/api/developer/foundation/connections/${connection.id}/check`,
        { method: "POST" }
      );
      if (!res.ok) {
        setNote({ tone: "error", text: res.error });
        return;
      }
      onChecked(res.data.connection);
      if (res.data.result === "error") {
        setNote({ tone: "muted", text: "Instagram hozir javob bermadi (limit yoki tarmoq). Token holati o'zgarmadi." });
      }
    } finally {
      setBusy(false);
    }
  }

  const reconnectFirst = connection.action.kind === "reconnect";

  return (
    <div className="panel rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-semibold text-foreground">@{connection.username}</span>
            <Pill tone={connection.tone}>{connection.title}</Pill>
            <span className="label-mono text-[10px] text-muted">{connection.status}</span>
          </div>
          <p className="mt-1 text-sm text-muted">{connection.explanation}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void recheck()}>
            {busy ? "Tekshirilmoqda…" : "Qayta tekshirish"}
          </button>
          <a href={RECONNECT_HREF} className={reconnectFirst ? primaryButton : secondaryButton}>
            Qayta ulash
          </a>
        </div>
      </div>
      {note && <p className={`mt-2 text-sm ${note.tone === "error" ? "text-error" : "text-muted"}`}>{note.text}</p>}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted">
        <span>Oxirgi tekshiruv: {formatDateTime(connection.tokenCheckedAt)}</span>
        <span>
          Token tugaydi: {formatDateTime(connection.tokenExpiresAt)}
          {connection.expiresInDays !== null && connection.expiresInDays >= 0 && ` (${connection.expiresInDays} kun)`}
        </span>
        <span>
          Webhook:{" "}
          <b className={connection.webhookSubscribed ? "text-success" : "text-warning"}>
            {connection.webhookSubscribed ? "obuna" : "obuna yo'q"}
          </b>
        </span>
        <span>Ulangan: {formatDateTime(connection.connectedAt)}</span>
      </div>
    </div>
  );
}

function ConnectionsTab({
  connections,
  onChecked,
}: {
  connections: ConnectionView[];
  onChecked: (next: ConnectionView) => void;
}) {
  if (connections.length === 0) {
    return (
      <div className="panel rounded-xl">
        <EmptyState title="Instagram akkaunt ulanmagan" body="Avtomatlashtirish ishlashi uchun akkaunt ulang." />
        <div className="pb-8 text-center">
          <a href={RECONNECT_HREF} className={primaryButton}>
            Instagram ulash
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {connections.map((c) => (
        <ConnectionCard key={c.id} connection={c} onChecked={onChecked} />
      ))}
    </div>
  );
}

// ── Diagnostika ──────────────────────────────────────────────────────────────

const DIAG_STYLE: Record<DiagnosticStatus, { icon: string; className: string; tone: DisplayTone; label: string }> = {
  ok: { icon: "✓", className: "text-success", tone: "success", label: "Yaxshi" },
  warning: { icon: "!", className: "text-warning", tone: "warning", label: "Diqqat" },
  error: { icon: "✕", className: "text-error", tone: "error", label: "Muammo" },
  unknown: { icon: "?", className: "text-muted", tone: "muted", label: "Noma'lum" },
};

function DiagnosticRow({ item, open, onToggle }: { item: DiagnosticItem; open: boolean; onToggle: () => void }) {
  const style = DIAG_STYLE[item.status];
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-current/[0.03]"
      >
        <span
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-full bg-current/10 text-xs font-bold ${style.className}`}
          aria-hidden="true"
        >
          {style.icon}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{item.label}</span>
        <span className={`min-w-0 break-words text-right text-sm ${item.status === "ok" ? "text-muted" : style.className}`}>
          {item.value}
        </span>
        <span className="shrink-0 text-xs text-muted" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <dl className="grid grid-cols-1 gap-3 px-4 pb-4 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="label-mono text-[11px] font-semibold text-muted">Status</dt>
          <dd>
            <Pill tone={style.tone}>{style.label}</Pill>
          </dd>
          <dt className="label-mono text-[11px] font-semibold text-muted">Nima degani</dt>
          <dd className="text-foreground">{item.meaning}</dd>
          <dt className="label-mono text-[11px] font-semibold text-muted">Oxirgi tekshiruv</dt>
          <dd className="text-foreground">{formatDateTime(item.lastCheck)}</dd>
          <dt className="label-mono text-[11px] font-semibold text-muted">Mumkin muammo</dt>
          <dd className="break-words text-foreground">{item.issue ?? "Muammo topilmadi."}</dd>
          <dt className="label-mono text-[11px] font-semibold text-muted">Tavsiya</dt>
          <dd className="text-foreground">
            {item.action ? (
              <span className="flex flex-wrap items-center gap-2">
                <span>{item.action.label}</span>
                {item.action.href && (
                  <a href={item.action.href} className={secondaryButton}>
                    Ochish →
                  </a>
                )}
              </span>
            ) : (
              "Harakat shart emas."
            )}
          </dd>
        </dl>
      )}
    </li>
  );
}

function DiagnosticsTab({ items }: { items: DiagnosticItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="panel overflow-hidden rounded-xl">
      {items.map((item) => (
        <DiagnosticRow
          key={item.key}
          item={item}
          open={open === item.key}
          onToggle={() => setOpen((current) => (current === item.key ? null : item.key))}
        />
      ))}
    </ul>
  );
}

// ── Navbat ───────────────────────────────────────────────────────────────────

const TRIGGER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Kutmoqda",
  PROCESSING: "Jarayonda",
  PROCESSED: "Qayta ishlandi",
  IGNORED: "E'tiborsiz",
  RETRYING: "Qayta urinish",
  FAILED: "Xato",
};

function QueueTab({ queue, workerHealthy }: { queue: FoundationOverview["queue"]; workerHealthy: boolean | null }) {
  const dm = queue.dm;
  const show = (value: number | null) => (value === null ? "—" : value);
  return (
    <div className="space-y-6">
      {workerHealthy === false && (dm.queued ?? 0) > 0 && (
        <p className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          Worker ishlamayapti — navbatdagi xabarlar yuborilmayapti.
        </p>
      )}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">DM navbati</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Navbatda" value={`${show(dm.queued)}${dm.truncated ? "+" : ""}`} tone={(dm.queued ?? 0) > 0 ? "text-warning" : undefined} />
          <Stat label="Jarayonda" value={show(dm.processing)} />
          <Stat label="Yuborildi · 24 soat" value={dm.completed24h} tone="text-success" />
          <Stat label="Xato · 24 soat" value={dm.failed24h} tone={dm.failed24h ? "text-error" : undefined} />
          <Stat label="Taxminiy vaqt" value={dm.etaLabel} />
        </div>
        <p className="text-xs text-muted">
          Oxirgi soatda {dm.sentLastHour} ta yuborildi · o&apos;tkazib yuborilgan (24 soat): {dm.skipped24h} · holat:{" "}
          {formatDateTime(queue.checkedAt)}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Soatlik limit (750 / soat)</h2>
        {queue.rate.length === 0 ? (
          <div className="panel rounded-xl">
            <EmptyState title="Akkaunt yo'q" />
          </div>
        ) : (
          <div className="panel divide-y divide-border rounded-xl">
            {queue.rate.map((row) => (
              <div key={row.instagramAccountId} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="break-all font-medium text-foreground">@{row.username}</span>
                  {row.usage ? (
                    <span className="text-muted">
                      {row.usage.used} / {row.usage.limit}
                      {row.usage.resetInSeconds !== null &&
                        ` · ${Math.ceil(row.usage.resetInSeconds / 60)} daqiqada yangilanadi`}
                    </span>
                  ) : (
                    <span className="text-muted">Noma&apos;lum (Redis)</span>
                  )}
                </div>
                {row.usage && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-border">
                    <div
                      className={`h-full rounded-full ${
                        row.usage.tone === "error" ? "bg-error" : row.usage.tone === "warning" ? "bg-warning" : "bg-success"
                      }`}
                      style={{ width: `${row.usage.percent}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Trigger engine (story reply va boshqalar)</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Hozir navbatda" value={queue.triggers.backlog} tone={queue.triggers.backlog ? "text-warning" : undefined} />
          {["PROCESSED", "IGNORED", "FAILED"].map((status) => (
            <Stat
              key={status}
              label={`${TRIGGER_STATUS_LABELS[status]} · 24 soat`}
              value={queue.triggers.last24h[status] ?? 0}
              tone={status === "FAILED" && queue.triggers.last24h[status] ? "text-error" : undefined}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

// ── Xatolar ──────────────────────────────────────────────────────────────────

const SEVERITY: Record<ErrorFeedItem["severity"], { tone: DisplayTone; label: string }> = {
  critical: { tone: "error", label: "Kritik" },
  error: { tone: "error", label: "Xato" },
  warning: { tone: "warning", label: "Ogohlantirish" },
  info: { tone: "muted", label: "Ma'lumot" },
};

const SOURCE_LABELS: Record<ErrorFeedItem["source"], string> = {
  dm: "DM",
  webhook: "Webhook",
  system: "Tizim",
  trigger: "Trigger",
};

function ErrorCard({ item }: { item: ErrorFeedItem }) {
  const severity = SEVERITY[item.severity];
  return (
    <div className="panel rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill tone={severity.tone}>{severity.label}</Pill>
          <span className="label-mono text-[10px] text-muted">
            {SOURCE_LABELS[item.source]} · {item.code}
          </span>
        </div>
        <span className="text-xs text-muted">{formatDateTime(item.occurredAt)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="label-mono text-[11px] font-semibold text-muted">Muammo</dt>
        <dd className="font-medium text-foreground">{item.problem}</dd>
        <dt className="label-mono text-[11px] font-semibold text-muted">Sabab</dt>
        <dd className="text-foreground">{item.cause}</dd>
        <dt className="label-mono text-[11px] font-semibold text-muted">Yechim</dt>
        <dd className="text-foreground">{item.solution}</dd>
      </dl>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="min-w-0 break-words text-xs text-muted">
          {item.related?.label ?? ""}
          {item.retryable ? " · avtomatik qayta urinadi" : ""}
        </span>
        {item.action.href ? (
          <a href={item.action.href} className={item.action.kind === "reconnect" ? primaryButton : secondaryButton}>
            {item.action.label}
          </a>
        ) : (
          item.action.kind !== "none" && <span className="text-xs text-muted">{item.action.label}</span>
        )}
      </div>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer select-none">Texnik ma&apos;lumot</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-current/5 p-2 font-mono text-[11px]">{item.technical}</pre>
      </details>
    </div>
  );
}

function ErrorsTab() {
  const [errors, setErrors] = useState<ErrorFeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const res = await getJson<{ errors: ErrorFeedItem[] }>("/api/developer/foundation/errors");
      if (id !== seq.current) return;
      if (res.ok) setErrors(res.data.errors);
      else setFailure(res.error);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++; // drop a response that lands after unmount
    };
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Oxirgi 7 kun: yuborilmagan DM, webhook va tizim xatolari.</p>
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
          {loading ? "Yuklanmoqda…" : "Yangilash"}
        </button>
      </div>
      {failure && <ErrorBanner message={failure} onRetry={() => void load()} />}
      {errors === null ? (
        loading && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : errors.length === 0 ? (
        <div className="panel rounded-xl">
          <EmptyState title="Xato yo'q" body="Oxirgi 7 kunda hech qanday xato qayd etilmagan." />
        </div>
      ) : (
        errors.map((item) => <ErrorCard key={item.id} item={item} />)
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FoundationDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = TABS.some(([key]) => key === tabParam) ? (tabParam as Tab) : "connections";

  const [overview, setOverview] = useState<FoundationOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const res = await getJson<FoundationOverview>("/api/developer/foundation/overview");
      if (id !== seq.current) return;
      if (res.ok) setOverview(res.data);
      else setFailure(res.error);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  const onChecked = useCallback(
    (next: ConnectionView) => {
      setOverview((current) =>
        current ? { ...current, connections: current.connections.map((c) => (c.id === next.id ? next : c)) } : current
      );
      // Diagnostics depend on the token too: refresh them in the background.
      void load();
    },
    [load]
  );

  const setTab = (next: Tab) => router.replace(`/developer/foundation?tab=${next}`, { scroll: false });

  const connected = overview?.connections.filter((c) => c.status === "CONNECTED" || c.status === "EXPIRING").length ?? 0;
  const problems = overview?.diagnostics.filter((d) => d.status === "error" || d.status === "warning").length ?? 0;
  const hasError = overview?.diagnostics.some((d) => d.status === "error") ?? false;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Foundation</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">Instagram ulanishi · Diagnostika · Navbat · Tushunarli xatolar</p>
        </div>
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
          {loading ? "Yangilanmoqda…" : "Yangilash"}
        </button>
      </div>

      {failure && <ErrorBanner message={failure} onRetry={() => void load()} />}

      {overview ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Ulangan akkauntlar"
            value={`${connected}/${overview.connections.length}`}
            tone={connected < overview.connections.length ? "text-warning" : undefined}
          />
          <Stat
            label="Diagnostika"
            value={problems ? `${problems} ta muammo` : "Hammasi joyida"}
            tone={hasError ? "text-error" : problems ? "text-warning" : "text-success"}
          />
          <Stat label="Navbatda" value={overview.queue.dm.queued ?? "—"} />
          <Stat label="Taxminiy vaqt" value={overview.queue.dm.etaLabel} />
        </div>
      ) : (
        <div className="h-[74px]" />
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "errors" ? (
        <ErrorsTab />
      ) : tab === "testdata" ? (
        <TestDataTab />
      ) : !overview ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : tab === "connections" ? (
        <ConnectionsTab connections={overview.connections} onChecked={onChecked} />
      ) : tab === "diagnostics" ? (
        <DiagnosticsTab items={overview.diagnostics} />
      ) : (
        <QueueTab queue={overview.queue} workerHealthy={overview.workerHealthy} />
      )}
    </div>
  );
}
