"use client";

/**
 * Instagram Triggers — the ETAP 3 home of the dev console.
 *
 * Tabs: Automations · Logs · Contacts · Simulator, under an engine status
 * strip (enabled, worker, queue, last 24 hours). The automations tab lists
 * every ETAP 3 trigger in one place — Direct, ad message, ig.me link, Story
 * Mention, Story Reply (V1) and Live comment — each opening its own builder.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AUDIENCE_LABELS, AUTOMATION_KIND_LABELS, EVENT_TYPE_LABELS, shortStoryId } from "@/lib/triggers/display";
import TriggerLogs from "./trigger-logs";
import {
  DevBadge,
  EmptyState,
  Field,
  formatDateTime,
  inputClass,
  Pill,
  primaryButton,
  secondaryButton,
  Toggle,
} from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { jsonInit, requestJson } from "@/components/developer/comments/shared";

interface Account {
  id: string;
  username: string;
  tokenStatus: string;
}

type Kind = "DIRECT" | "AD_MESSAGE" | "LINK" | "STORY_MENTION" | "STORY_REPLY" | "LIVE_COMMENT";

interface Automation {
  id: string;
  name: string;
  kind: Kind;
  href: string;
  triggerType: string;
  active: boolean;
  createdAt: string;
  matchingMode: string;
  keywords: string[];
  intents: string[];
  storyScope: string;
  storyIds: string[];
  audience: string;
  adIds: string[];
  refs: string[];
  responseMessage: string;
  unapprovedVariants: number;
  instagramAccount: { username: string; tokenStatus: string };
  stats: { sent: number; queued: number; failed: number; skipped: number; leads: number; followUpsScheduled: number };
}

interface Overview {
  enabled: boolean;
  workerHealthy: boolean;
  queue: Record<string, number> | null;
  last24h: { byStatus: Record<string, number>; byType: Record<string, number>; sent: number };
  activeCampaigns: number;
  contacts: number;
}

const TABS = [
  ["campaigns", "Automationlar"],
  ["logs", "Loglar"],
  ["contacts", "Kontaktlar"],
  ["simulator", "Simulyator"],
] as const;
type Tab = (typeof TABS)[number][0];

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="panel rounded-xl px-4 py-3">
      <p className="label-mono text-[10px] font-semibold text-muted">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function OverviewStrip({ overview }: { overview: Overview | null }) {
  if (!overview) return <div className="h-[74px]" />;
  const s = overview.last24h.byStatus;
  const failed = (s.FAILED ?? 0) + (s.RETRYING ?? 0);
  return (
    <div className="space-y-3">
      {!overview.enabled && (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Engine o&apos;chirilgan (TRIGGER_ENGINE_DISABLED). Webhook eventlari yozilmaydi.
        </p>
      )}
      {overview.enabled && !overview.workerHealthy && (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Worker javob bermayapti — eventlar navbatda turib qoladi.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="24 soat · eventlar" value={Object.values(s).reduce((a, b) => a + b, 0)} />
        <Stat label="24 soat · yuborildi" value={overview.last24h.sent} tone="text-success" />
        <Stat label="24 soat · xato / retry" value={failed} tone={failed ? "text-error" : undefined} />
        <Stat
          label="Navbat"
          value={overview.queue ? `${overview.queue.waiting ?? 0} / ${overview.queue.delayed ?? 0}` : "—"}
        />
      </div>
    </div>
  );
}

/** Which route family toggles / deletes a campaign of this kind. */
function campaignApi(automation: Automation): string {
  if (automation.kind === "STORY_REPLY") return `/api/developer/triggers/campaigns/${automation.id}`;
  if (automation.kind === "LIVE_COMMENT") return `/api/developer/comments/campaigns/${automation.id}`;
  return `/api/developer/triggers/dm/campaigns/${automation.id}`;
}

function logsHref(automation: Automation): string {
  return automation.kind === "STORY_REPLY"
    ? `/developer/triggers?tab=logs&campaign=${automation.id}`
    : `${automation.href}?tab=logs`;
}

/** The condition in one line: what the person must do to get this answer. */
function conditionText(a: Automation): string {
  const parts: string[] = [];
  if (a.kind === "STORY_REPLY") {
    parts.push(a.storyScope === "ALL" ? "Barcha story" : `${a.storyIds.length} story (${a.storyIds.map(shortStoryId).join(", ")})`);
  }
  if (a.kind === "AD_MESSAGE") parts.push(a.adIds.length ? `${a.adIds.length} ta reklama` : "Istalgan reklama");
  if (a.kind === "LINK") parts.push(a.refs.length ? `ref: ${a.refs.slice(0, 3).join(", ")}${a.refs.length > 3 ? "…" : ""}` : "Istalgan ref");
  if (a.kind === "STORY_MENTION") parts.push("Har bir mention");
  else if (a.matchingMode === "EVERY") parts.push("Har bir xabar");
  else parts.push(a.matchingMode === "EXACT" ? "Aniq kalit so'z" : "Kalit so'z bor");
  if (a.audience && a.audience !== "ANY") parts.push(AUDIENCE_LABELS[a.audience]?.title ?? a.audience);
  return parts.join(" · ");
}

const KIND_FILTERS: Array<["" | Kind, string]> = [
  ["", "Barchasi"],
  ["DIRECT", AUTOMATION_KIND_LABELS.DIRECT.title],
  ["AD_MESSAGE", AUTOMATION_KIND_LABELS.AD_MESSAGE.title],
  ["LINK", AUTOMATION_KIND_LABELS.LINK.title],
  ["STORY_MENTION", AUTOMATION_KIND_LABELS.STORY_MENTION.title],
  ["STORY_REPLY", AUTOMATION_KIND_LABELS.STORY_REPLY.title],
  ["LIVE_COMMENT", AUTOMATION_KIND_LABELS.LIVE_COMMENT.title],
];

function AutomationCard({ automation, onChanged }: { automation: Automation; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = automation.stats;

  async function mutate(init: RequestInit, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(campaignApi(automation), init);
      if (!res.ok) setError(res.error || fallback);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const warnings: string[] = [];
  if (automation.instagramAccount.tokenStatus === "BROKEN") {
    warnings.push("Akkaunt ulanishi uzilgan — javoblar ketmaydi. Foundation → Ulanishlar bo'limida qayta ulang.");
  }
  if (automation.unapprovedVariants > 0) {
    warnings.push(`${automation.unapprovedVariants} ta variant tasdiqlanmagan — ular yuborilmaydi.`);
  }

  return (
    <li className="panel rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`label-mono rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                automation.kind === "LIVE_COMMENT" ? "bg-error/10 text-error" : "bg-accent/10 text-accent"
              }`}
            >
              {AUTOMATION_KIND_LABELS[automation.kind]?.title ?? automation.kind}
            </span>
            <Link href={automation.href} className="break-words font-semibold text-foreground hover:text-accent">
              {automation.name}
            </Link>
            <Pill tone={automation.active ? "success" : "muted"}>{automation.active ? "Faol" : "O'chiq"}</Pill>
          </div>
          <p className="mt-1 text-xs text-muted">
            @{automation.instagramAccount.username} · {conditionText(automation)}
          </p>
          {(automation.keywords.length > 0 || automation.intents.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {automation.keywords.slice(0, 10).map((k) => (
                <span key={k} className="rounded-md bg-accent/10 px-1.5 py-0.5 text-xs text-foreground">
                  {k}
                </span>
              ))}
              {automation.intents.map((k) => (
                <span key={k} className="label-mono rounded-md bg-gold/10 px-1.5 py-0.5 text-[10px] text-gold">
                  {k}
                </span>
              ))}
              {automation.keywords.length > 10 && <span className="text-xs text-muted">+{automation.keywords.length - 10}</span>}
            </div>
          )}
        </div>
        <Toggle
          on={automation.active}
          onChange={(on) => void mutate(jsonInit("PATCH", { active: on }), "Holatni o'zgartirib bo'lmadi")}
          label={`${automation.name} faol`}
        />
      </div>

      {warnings.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {warnings.map((w) => (
            <Notice key={w} tone="warning">
              {w}
            </Notice>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted">
          <span>
            Yuborildi: <b className="text-success">{s.sent}</b>
          </span>
          <span>
            Navbatda: <b className={s.queued ? "text-warning" : ""}>{s.queued}</b>
          </span>
          <span>
            Xato: <b className={s.failed ? "text-error" : ""}>{s.failed}</b>
          </span>
          {s.leads > 0 && (
            <span>
              Lead: <b className="text-success">{s.leads}</b>
            </span>
          )}
          {s.followUpsScheduled > 0 && (
            <span>
              Follow-up rejada: <b>{s.followUpsScheduled}</b>
            </span>
          )}
          <span>Yaratildi: {formatDateTime(automation.createdAt)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={logsHref(automation)} className={secondaryButton}>
            Loglar
          </Link>
          <Link href={automation.href} className={secondaryButton}>
            Tahrirlash
          </Link>
          <ConfirmButton
            label="O'chirish"
            question="Automation va uning loglari o'chirilsinmi?"
            confirmLabel="O'chirish"
            danger
            busy={busy}
            onConfirm={() => void mutate({ method: "DELETE" }, "O'chirib bo'lmadi")}
          />
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-error">{error}</p>}
    </li>
  );
}

function CampaignsTab({
  automations,
  accounts,
  onChanged,
}: {
  automations: Automation[];
  accounts: Account[];
  onChanged: () => void;
}) {
  const [kind, setKind] = useState<"" | Kind>("");
  const counts = automations.reduce<Record<string, number>>((acc, a) => {
    acc[a.kind] = (acc[a.kind] ?? 0) + 1;
    return acc;
  }, {});
  const shown = kind ? automations.filter((a) => a.kind === kind) : automations;

  if (automations.length === 0) {
    return (
      <div className="panel rounded-xl">
        <EmptyState
          title="Hali automation yo'q"
          body={
            accounts.length
              ? "Direct, reklama, ig.me havola, story mention/reply yoki live komment uchun avtomatik javob yarating."
              : "Avval Instagram akkaunt ulang (Foundation → Ulanishlar)."
          }
        />
        {accounts.length > 0 && (
          <div className="pb-8 text-center">
            <Link href="/developer/triggers/new" className={primaryButton}>
              + Yangi automation
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Trigger turi bo'yicha filtr">
        {KIND_FILTERS.filter(([key]) => !key || counts[key]).map(([key, label]) => (
          <button
            key={key || "all"}
            type="button"
            aria-pressed={kind === key}
            onClick={() => setKind(key)}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              kind === key ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {label} <span className="text-muted">{key ? counts[key] : automations.length}</span>
          </button>
        ))}
      </div>
      <ul className="space-y-3">
        {shown.map((automation) => (
          <AutomationCard key={automation.id} automation={automation} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  );
}

interface ContactRow {
  id: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  source: string;
  firstInteractionAt: string;
  lastInteractionAt: string;
  interactionCount: number;
  instagramAccount: { username: string };
  conversation: { id: string; _count: { messages: number } } | null;
}

function ContactsTab() {
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/developer/triggers/contacts?page=${page}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.success) {
          setError(data.error ?? "Yuklab bo'lmadi");
          return;
        }
        setError(null);
        setContacts(data.data.contacts);
        setTotalPages(data.data.pagination.totalPages);
      })
      .catch(() => {
        if (!cancelled) setError("Yuklab bo'lmadi");
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  if (!contacts) {
    return (
      <p className={`py-10 text-center text-sm ${error ? "text-error" : "text-muted"}`}>{error ?? "Yuklanmoqda…"}</p>
    );
  }
  if (contacts.length === 0) {
    return (
      <div className="panel rounded-xl">
        <EmptyState title="Hali kontakt yo'q" body="Birinchi xabar (Direct, story, mention) kelganda kontakt avtomatik yaratiladi." />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="panel overflow-x-auto rounded-xl">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Kontakt</th>
              <th className="px-4 py-2.5 font-medium">Manba</th>
              <th className="px-4 py-2.5 font-medium">Birinchi</th>
              <th className="px-4 py-2.5 font-medium">Oxirgi</th>
              <th className="px-4 py-2.5 font-medium">Interaksiya</th>
              <th className="px-4 py-2.5 font-medium">Xabarlar</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5">
                  <p className="font-medium text-foreground">{c.username ? `@${c.username}` : `id ${c.igUserId.slice(-6)}`}</p>
                  <p className="text-xs text-muted">
                    {c.name ?? "—"} · @{c.instagramAccount.username}
                  </p>
                </td>
                <td className="px-4 py-2.5 text-muted">{EVENT_TYPE_LABELS[c.source] ?? c.source}</td>
                <td className="px-4 py-2.5 text-xs text-muted">{formatDateTime(c.firstInteractionAt)}</td>
                <td className="px-4 py-2.5 text-xs text-muted">{formatDateTime(c.lastInteractionAt)}</td>
                <td className="px-4 py-2.5 text-foreground">{c.interactionCount}</td>
                <td className="px-4 py-2.5 text-foreground">{c.conversation?._count.messages ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button type="button" className={secondaryButton} disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Oldingi
          </button>
          <span className="text-muted">
            {page} / {totalPages}
          </span>
          <button type="button" className={secondaryButton} disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            Keyingi
          </button>
        </div>
      )}
    </div>
  );
}

type SimType = "STORY_REPLY" | "COMMENT" | "LIVE_COMMENT" | "DIRECT_MESSAGE" | "STORY_MENTION" | "AD_MESSAGE" | "LINK";

const SIM_TYPES: Array<[SimType, string]> = [
  ["STORY_REPLY", "Story javobi"],
  ["COMMENT", "Post komment"],
  ["LIVE_COMMENT", "Live komment"],
  ["DIRECT_MESSAGE", "Direct xabar"],
  ["STORY_MENTION", "Story'da belgilash"],
  ["AD_MESSAGE", "Reklamadan xabar"],
  ["LINK", "ig.me havoladan"],
];

/** One result shape for every simulator endpoint (they all answer "who replies, why, with what"). */
interface SimView {
  selected: { name: string; matchedKeyword: string | null; text: string | null; publicText?: string | null } | null;
  reason: string | null;
  others: Array<{ id: string; name: string; matched: boolean; matchedKeyword: string | null; reason: string | null }>;
}

function SimulatorTab({ accounts }: { accounts: Account[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [type, setType] = useState<SimType>("STORY_REPLY");
  const [text, setText] = useState("Narxi qancha?");
  const [storyId, setStoryId] = useState("");
  const [mediaId, setMediaId] = useState("");
  const [adId, setAdId] = useState("");
  const [ref, setRef] = useState("");
  const [result, setResult] = useState<SimView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const noText = type === "STORY_MENTION";

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: string };
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      let view: SimView;
      if (type === "STORY_REPLY") {
        const data = await post("/api/developer/triggers/simulate", { instagramAccountId: accountId, text, storyId: storyId.trim() || null });
        if (!data.success) throw new Error(data.error ?? "Xato");
        const d = data.data as unknown as { selected: { name: string; matchedKeyword: string | null; responseMessage: string } | null; ignoredReason: string | null; campaigns: SimView["others"] };
        view = {
          selected: d.selected ? { name: d.selected.name, matchedKeyword: d.selected.matchedKeyword, text: d.selected.responseMessage } : null,
          reason: d.ignoredReason,
          others: d.campaigns,
        };
      } else {
        const comment = type === "COMMENT" || type === "LIVE_COMMENT";
        const data = comment
          ? await post("/api/developer/comments/simulate", { instagramAccountId: accountId, text, mediaId: type === "COMMENT" ? mediaId.trim() || null : null, eventType: type })
          : await post("/api/developer/triggers/dm/simulate", {
              instagramAccountId: accountId,
              eventType: type === "STORY_MENTION" ? "STORY_MENTION" : "DIRECT_MESSAGE",
              text: noText ? "" : text,
              referralSource: type === "AD_MESSAGE" ? "ADS" : type === "LINK" ? "LINK" : null,
              adId: type === "AD_MESSAGE" ? adId.trim() || null : null,
              ref: type === "LINK" ? ref.trim() || null : null,
            });
        if (!data.success) throw new Error(data.error ?? "Xato");
        const d = data.data as { matched: boolean; campaignName?: string; matchedKeyword?: string | null; dmPreview?: string | null; replyPreview?: string | null; publicPreview?: string | null; reason?: string | null };
        view = {
          selected: d.matched ? { name: d.campaignName ?? "Kampaniya", matchedKeyword: d.matchedKeyword ?? null, text: d.dmPreview ?? d.replyPreview ?? null, publicText: d.publicPreview ?? null } : null,
          reason: d.reason ?? null,
          others: [],
        };
      }
      setResult(view);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error && e.message ? e.message : "Xato");
    } finally {
      setRunning(false);
    }
  }

  const textLabel = type === "STORY_REPLY" ? "Reply matni" : type === "DIRECT_MESSAGE" || type === "AD_MESSAGE" || type === "LINK" ? "Xabar matni" : "Komment matni";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="panel min-w-0 space-y-4 rounded-xl p-4">
        <p className="text-sm text-muted">
          Tanlangan turdagi hodisa kelganda engine qaysi kampaniyani tanlashini tekshiradi. Hech narsa yuborilmaydi va saqlanmaydi.
          Faol kampaniyalar tekshiriladi; o&apos;chiq kampaniyani uning o&apos;z sahifasidagi «Test» bo&apos;limida sinang.
        </p>
        <Field label="Hodisa turi">
          <select
            className={inputClass}
            value={type}
            onChange={(e) => {
              setType(e.target.value as SimType);
              setResult(null);
            }}
          >
            {SIM_TYPES.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Akkaunt">
          <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username}
              </option>
            ))}
          </select>
        </Field>
        {noText ? (
          <p className="text-xs text-muted">Story&apos;da belgilashda matn bo&apos;lmaydi: odam story&apos;sida akkauntni belgilaydi.</p>
        ) : (
          <Field label={textLabel}>
            <textarea className={`${inputClass} min-h-20`} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}
        {type === "STORY_REPLY" && (
          <Field label="Story ID (ixtiyoriy)" hint="Aniq story kampaniyalarini tekshirish uchun">
            <input className={inputClass} value={storyId} onChange={(e) => setStoryId(e.target.value)} />
          </Field>
        )}
        {type === "COMMENT" && (
          <Field label="Post ID (ixtiyoriy)" hint="Aniq post kampaniyalarini tekshirish uchun">
            <input className={inputClass} value={mediaId} onChange={(e) => setMediaId(e.target.value)} />
          </Field>
        )}
        {type === "AD_MESSAGE" && (
          <Field label="Reklama ID (ixtiyoriy)">
            <input className={inputClass} value={adId} onChange={(e) => setAdId(e.target.value)} />
          </Field>
        )}
        {type === "LINK" && (
          <Field label="Havola ref (ixtiyoriy)">
            <input className={inputClass} value={ref} onChange={(e) => setRef(e.target.value)} />
          </Field>
        )}
        <button type="button" onClick={() => void run()} disabled={running || !accountId || (!noText && !text.trim())} className={primaryButton}>
          {running ? "Tekshirilmoqda…" : "Tekshirish"}
        </button>
        {error && <p className="text-sm text-error">{error}</p>}
      </div>

      <div className="panel min-w-0 rounded-xl p-4">
        {!result ? (
          <EmptyState title="Natija shu yerda" />
        ) : (
          <div className="space-y-4 text-sm">
            {result.selected ? (
              <div className="rounded-lg border border-success/30 bg-success/5 p-3">
                <p className="font-semibold text-success">✓ {result.selected.name} javob beradi</p>
                {result.selected.matchedKeyword && <p className="mt-1 text-muted">Kalit so&apos;z: {result.selected.matchedKeyword}</p>}
                {result.selected.publicText && (
                  <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-surface-hover px-2 py-1.5 text-foreground">Ochiq javob: {result.selected.publicText}</p>
                )}
                {result.selected.text && (
                  <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-surface-hover px-2 py-1.5 text-foreground">{result.selected.text}</p>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-border p-3">
                <p className="font-semibold text-foreground">Hech qaysi kampaniya javob bermaydi</p>
                <p className="mt-1 text-muted">{result.reason ?? "Mos kampaniya topilmadi."}</p>
              </div>
            )}
            {result.others.length > 0 && (
              <ul className="space-y-1.5">
                {result.others.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <span className="min-w-0 truncate text-foreground">{c.name}</span>
                    <span className={`shrink-0 text-xs ${c.matched ? "text-success" : "text-muted"}`}>
                      {c.matched ? `mos${c.matchedKeyword ? ` · ${c.matchedKeyword}` : ""}` : c.reason}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TriggerDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = TABS.some(([key]) => key === tabParam) ? (tabParam as Tab) : "campaigns";
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [c, o] = await Promise.all([
      fetch("/api/developer/triggers/automations").then((r) => r.json()).catch(() => null),
      fetch("/api/developer/triggers/overview").then((r) => r.json()).catch(() => null),
    ]);
    if (c?.success) {
      setAutomations(c.data.automations);
      setAccounts(c.data.accounts);
    }
    if (o?.success) setOverview(o.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const setTab = (next: Tab) => router.replace(`/developer/triggers?tab=${next}`, { scroll: false });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Instagram Triggers</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Direct · Reklama · ig.me havola · Story mention / reply · Live komment → avtomatik javob → log
          </p>
          <p className="mt-1 text-xs text-muted">
            Post kommentlari{" "}
            <Link href="/developer/comments" className="text-accent hover:underline">
              Comment Automation 2.0
            </Link>{" "}
            bo&apos;limida (Live kampaniyalar shu ro&apos;yxatda ham ko&apos;rinadi).
          </p>
        </div>
        <Link href="/developer/triggers/new" className={primaryButton}>
          + Yangi automation
        </Link>
      </div>

      <OverviewStrip overview={overview} />

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

      {!loaded ? (
        <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : tab === "campaigns" ? (
        <CampaignsTab automations={automations} accounts={accounts} onChanged={() => void load()} />
      ) : tab === "logs" ? (
        <TriggerLogs
          key={`${searchParams.get("campaign") ?? ""}:${searchParams.get("type") ?? ""}`}
          campaigns={automations}
          initialCampaignId={searchParams.get("campaign") ?? ""}
          initialType={searchParams.get("type")}
        />
      ) : tab === "contacts" ? (
        <ContactsTab />
      ) : (
        <SimulatorTab accounts={accounts} />
      )}
    </div>
  );
}
