"use client";

/**
 * Leads — everything the assistant (or a customer typing a number into a
 * campaign DM) captured, with per-integration delivery state, filters, CSV
 * export and a manual "resend".
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { Badge, Button, Notice, inputClass } from "@/components/assistant-ui";
import { useLanguage } from "@/components/language-provider";
import { formatShortMonthDayTime } from "@/lib/i18n/format-date";

interface DeliveryBadge {
  id: string;
  status: "PENDING" | "SENT" | "FAILED" | "DEAD";
  type: "TELEGRAM" | "AMOCRM" | "BITRIX24";
  name: string;
}

interface LeadRow {
  id: string;
  createdAt: string;
  name: string | null;
  phoneE164: string | null;
  igUsername: string | null;
  productInterest: string | null;
  source: "CAMPAIGN" | "INBOUND_DM";
  campaignName: string | null;
  status: "NEW" | "SENT" | "PARTIAL" | "FAILED";
  flag: string | null;
  isTest: boolean;
  isRepeat: boolean;
  contactedAt: string | null;
  conversationId: string | null;
  accountUsername: string;
  deliveries: DeliveryBadge[];
}

interface LeadDetail extends Omit<LeadRow, "deliveries"> {
  summary: string | null;
  transcript: string | null;
  triggerKeyword: string | null;
  postUrl: string | null;
  trackedLinkClicked: boolean;
  repeatCount: number;
  deliveries: Array<{
    id: string;
    type: DeliveryBadge["type"];
    name: string;
    kind: string;
    status: DeliveryBadge["status"];
    attempts: number;
    lastError: string | null;
    externalUrl: string | null;
    sentAt: string | null;
    nextAttemptAt: string | null;
  }>;
}

const DELIVERY_TONE = {
  SENT: "success",
  PENDING: "warning",
  FAILED: "warning",
  DEAD: "error",
} as const;

export default function LeadsPage() {
  const { t, locale } = useLanguage();
  const L = t.assistant.leads;

  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);

  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [account, setAccount] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);

  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((p) => p.success && setAccounts(p.data.instagramAccounts ?? []))
      .catch(() => setAccounts([]));
  }, []);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (source) params.set("source", source);
    if (account !== "all") params.set("account", account);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    return params;
  }, [status, source, account, from, to, debouncedQuery]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = filterParams();
      params.set("page", String(page));
      const res = await fetch(`/api/leads?${params}`, { cache: "no-store" });
      const payload = await res.json();
      if (!payload.success) throw new Error(payload.error);
      setLeads(payload.data.leads);
      setTotal(payload.data.total);
      setPageSize(payload.data.pageSize);
      setCanManage(payload.data.canManage);
    } catch {
      setError(t.assistant.common.loadError);
    } finally {
      setLoading(false);
    }
  }, [filterParams, page, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await fetch(`/api/leads/${id}`, { cache: "no-store" });
      const payload = await res.json();
      if (payload.success) setDetail(payload.data.lead);
    } finally {
      setDetailLoading(false);
    }
  }

  async function redeliver(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/leads/${id}/redeliver`, { method: "POST" });
      const payload = await res.json();
      if (payload.success) {
        setMessage(L.redeliverQueued(payload.data.queued));
        void load();
        if (detail?.id === id) void openDetail(id);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function copyPhone(phone: string) {
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(phone);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard may be blocked; nothing else to do
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const exportHref = `/api/leads/export.csv?${filterParams()}`;
  const hasFailure = (row: LeadRow) =>
    row.deliveries.some((d) => d.status === "DEAD" || d.status === "FAILED");

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{L.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">{L.subtitle}</p>
        </div>
        <a
          href={exportHref}
          className="inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-hover"
        >
          {L.export}
        </a>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder={L.searchPlaceholder}
          className={`${inputClass} lg:col-span-2`}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className={inputClass}
          aria-label={L.columns.delivery}
        >
          <option value="">{L.allStatuses}</option>
          {Object.entries(L.status).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setPage(1);
          }}
          className={inputClass}
          aria-label={L.columns.source}
        >
          <option value="">{L.allSources}</option>
          {Object.entries(L.source).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setPage(1);
          }}
          className={inputClass}
          aria-label={L.from}
        />
        <input
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setPage(1);
          }}
          className={inputClass}
          aria-label={L.to}
        />
        {accounts.length > 1 && (
          <div className="sm:col-span-2 lg:col-span-6">
            <AccountSelect
              accounts={accounts}
              value={account}
              onChange={(value) => {
                setAccount(value);
                setPage(1);
              }}
            />
          </div>
        )}
      </div>

      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="panel overflow-hidden rounded">
        {loading && leads.length === 0 ? (
          <div className="h-48 animate-pulse bg-surface-hover/40" />
        ) : leads.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium text-foreground">{L.empty}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">{L.emptyHelp}</p>
            <div className="mt-4">
              <Link href="/assistant" className="text-sm font-medium text-accent underline">
                {t.assistant.nav.assistant}
              </Link>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted">
                  {[L.columns.date, L.columns.name, L.columns.phone, L.columns.username, L.columns.interest, L.columns.source, L.columns.delivery, L.columns.actions].map(
                    (h) => (
                      <th key={h} className="label-mono px-3 py-2.5 font-normal">
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-b border-border/60 align-top last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-muted">
                      {formatShortMonthDayTime(new Date(lead.createdAt), locale)}
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium text-foreground">{lead.name ?? "—"}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {lead.isTest && <Badge tone="muted">{L.test}</Badge>}
                        {lead.isRepeat && <Badge tone="accent">🔁 {L.repeat}</Badge>}
                        {lead.flag === "complaint" && <Badge tone="error">🔴 {L.complaint}</Badge>}
                        {lead.flag === "no_phone" && <Badge tone="warning">🟡 {L.noPhone}</Badge>}
                        {lead.contactedAt && <Badge tone="success">✅ {L.contacted}</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {lead.phoneE164 ? (
                        <button
                          type="button"
                          onClick={() => void copyPhone(lead.phoneE164!)}
                          title={L.copyPhone}
                          className="font-mono text-xs text-foreground hover:text-accent"
                        >
                          {copied === lead.phoneE164 ? t.assistant.common.copied : lead.phoneE164}
                        </button>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-muted">
                      {lead.igUsername ? `@${lead.igUsername}` : "—"}
                    </td>
                    <td className="max-w-[200px] px-3 py-3 text-foreground">
                      <span className="line-clamp-2">{lead.productInterest ?? "—"}</span>
                    </td>
                    <td className="px-3 py-3 text-xs text-muted">
                      {L.source[lead.source]}
                      {lead.campaignName && <span className="block truncate">{lead.campaignName}</span>}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {lead.deliveries.length === 0 ? (
                          <span className="text-xs text-muted">—</span>
                        ) : (
                          lead.deliveries.map((d) => (
                            <Badge key={d.id} tone={DELIVERY_TONE[d.status]}>
                              {L.delivery[d.type]} {d.status === "SENT" ? "✓" : d.status === "DEAD" ? "✗" : "…"}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void openDetail(lead.id)}
                          className="text-xs font-medium text-accent hover:underline"
                        >
                          {L.details}
                        </button>
                        {lead.conversationId && (
                          <Link
                            href={`/inbox?conversation=${lead.conversationId}`}
                            className="text-xs font-medium text-muted hover:text-foreground"
                          >
                            {L.openChat}
                          </Link>
                        )}
                        {canManage && hasFailure(lead) && (
                          <button
                            type="button"
                            disabled={busyId === lead.id}
                            onClick={() => void redeliver(lead.id)}
                            className="text-xs font-medium text-warning hover:underline disabled:opacity-50"
                          >
                            {busyId === lead.id ? L.redelivering : L.redeliver}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <Button tone="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            {L.prev}
          </Button>
          <span className="text-sm text-muted">{L.page(page, pages)}</span>
          <Button tone="ghost" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
            {L.next}
          </Button>
        </div>
      )}

      {(detail || detailLoading) && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-0 sm:items-center sm:p-6"
          onClick={() => setDetail(null)}
        >
          <div
            className="panel max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded p-5"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {detailLoading || !detail ? (
              <div className="h-40 animate-pulse rounded bg-surface-hover/40" />
            ) : (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">{detail.name ?? "—"}</h2>
                    <p className="mt-0.5 font-mono text-xs text-muted">
                      {detail.phoneE164 ?? L.noPhone}
                      {detail.igUsername ? ` · @${detail.igUsername}` : ""}
                    </p>
                  </div>
                  <Button tone="ghost" onClick={() => setDetail(null)}>
                    {t.assistant.common.close}
                  </Button>
                </div>

                {detail.isRepeat || detail.repeatCount > 0 ? (
                  <Notice tone="warning">{L.detail.repeatNote(detail.repeatCount + (detail.isRepeat ? 2 : 1))}</Notice>
                ) : null}

                <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted">{L.columns.interest}</dt>
                    <dd>{detail.productInterest ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{L.columns.source}</dt>
                    <dd>
                      {L.source[detail.source]}
                      {detail.campaignName ? ` · ${detail.campaignName}` : ""}
                    </dd>
                  </div>
                  {detail.triggerKeyword && (
                    <div>
                      <dt className="text-xs text-muted">{L.detail.keyword}</dt>
                      <dd>{detail.triggerKeyword}</dd>
                    </div>
                  )}
                  {detail.trackedLinkClicked && (
                    <div>
                      <dt className="text-xs text-muted">{L.detail.tracked}</dt>
                      <dd>{L.detail.trackedYes}</dd>
                    </div>
                  )}
                </dl>

                {detail.summary && (
                  <div>
                    <h3 className="text-xs font-semibold text-muted">{L.detail.summary}</h3>
                    <p className="mt-1 text-sm text-foreground">{detail.summary}</p>
                  </div>
                )}

                <div>
                  <h3 className="text-xs font-semibold text-muted">{L.detail.deliveries}</h3>
                  {detail.deliveries.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">{L.detail.noDeliveries}</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detail.deliveries.map((d) => (
                        <li key={d.id} className="rounded border border-border p-2.5 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-foreground">
                              {d.name}
                              {d.kind === "repeat" ? " 🔁" : ""}
                            </span>
                            <Badge tone={DELIVERY_TONE[d.status]}>{L.delivery[d.status]}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted">
                            {L.detail.attempts(d.attempts)}
                            {d.nextAttemptAt && d.status !== "SENT"
                              ? ` · ${L.detail.nextAttempt(formatShortMonthDayTime(new Date(d.nextAttemptAt), locale))}`
                              : ""}
                          </p>
                          {d.lastError && d.status !== "SENT" && (
                            <p className="mt-1 break-words text-xs text-error">{d.lastError}</p>
                          )}
                          {d.externalUrl && (
                            <a
                              href={d.externalUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-block text-xs font-medium text-accent hover:underline"
                            >
                              {L.detail.openInCrm}
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canManage && detail.deliveries.some((d) => d.status === "DEAD" || d.status === "FAILED") && (
                    <div className="mt-3">
                      <Button disabled={busyId === detail.id} onClick={() => void redeliver(detail.id)}>
                        {busyId === detail.id ? L.redelivering : L.redeliver}
                      </Button>
                    </div>
                  )}
                </div>

                {detail.transcript && (
                  <div>
                    <h3 className="text-xs font-semibold text-muted">{L.detail.transcript}</h3>
                    <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface p-3 text-xs text-foreground">
                      {detail.transcript}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
