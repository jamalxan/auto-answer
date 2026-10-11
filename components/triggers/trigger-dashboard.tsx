"use client";

/**
 * Instagram Trigger Engine — dev console.
 *
 * Tabs: Campaigns · Logs · Contacts · Simulator, under an engine status strip
 * (enabled, worker, queue, last 24 hours).
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EVENT_TYPE_LABELS, MATCH_MODE_LABELS, shortStoryId } from "@/lib/triggers/display";
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
} from "./trigger-ui";

interface Account {
  id: string;
  username: string;
  tokenStatus: string;
}

interface Campaign {
  id: string;
  name: string;
  triggerType: string;
  storyScope: string;
  storyIds: string[];
  keywords: string[];
  matchingMode: string;
  responseMessage: string;
  active: boolean;
  createdAt: string;
  instagramAccount: { username: string };
  stats: { sent: number; failed: number; retrying: number };
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
  ["campaigns", "Campaignlar"],
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

function CampaignsTab({
  campaigns,
  accounts,
  onChanged,
}: {
  campaigns: Campaign[];
  accounts: Account[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(campaign: Campaign, active: boolean) {
    setBusy(campaign.id);
    await fetch(`/api/dev/triggers/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    setBusy(null);
    onChanged();
  }

  async function remove(campaign: Campaign) {
    if (!window.confirm(`"${campaign.name}" o'chirilsinmi? Loglari ham o'chadi.`)) return;
    setBusy(campaign.id);
    await fetch(`/api/dev/triggers/campaigns/${campaign.id}`, { method: "DELETE" });
    setBusy(null);
    onChanged();
  }

  if (campaigns.length === 0) {
    return (
      <div className="panel rounded-xl">
        <EmptyState
          title="Hali campaign yo'q"
          body={accounts.length ? "Story reply campaign yarating — reply kelganda avtomatik DM ketadi." : "Avval Instagram akkaunt ulang."}
        />
        {accounts.length > 0 && (
          <div className="pb-8 text-center">
            <Link href="/dev/triggers/new" className={primaryButton}>
              + Automation yaratish
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {campaigns.map((campaign) => (
        <div key={campaign.id} className="panel rounded-xl p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/dev/triggers/${campaign.id}`} className="font-semibold text-foreground hover:text-accent">
                  {campaign.name}
                </Link>
                <Pill tone={campaign.active ? "success" : "muted"}>{campaign.active ? "Faol" : "O'chiq"}</Pill>
              </div>
              <p className="mt-1 text-xs text-muted">
                @{campaign.instagramAccount.username} · {EVENT_TYPE_LABELS[campaign.triggerType]} ·{" "}
                {campaign.storyScope === "ALL"
                  ? "All stories"
                  : `${campaign.storyIds.length} story (${campaign.storyIds.map(shortStoryId).join(", ")})`}{" "}
                · {MATCH_MODE_LABELS[campaign.matchingMode]}
              </p>
              {campaign.keywords.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {campaign.keywords.map((k) => (
                    <span key={k} className="rounded-md bg-accent/10 px-1.5 py-0.5 text-xs text-foreground">
                      {k}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 line-clamp-2 break-words text-sm text-muted">{campaign.responseMessage}</p>
            </div>
            <div className="flex items-center gap-3">
              <Toggle on={campaign.active} onChange={(on) => void toggle(campaign, on)} label="Faol" />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs">
            <div className="flex flex-wrap gap-3 text-muted">
              <span>
                Yuborildi: <b className="text-success">{campaign.stats.sent}</b>
              </span>
              <span>
                Xato: <b className={campaign.stats.failed ? "text-error" : ""}>{campaign.stats.failed}</b>
              </span>
              <span>
                Retry: <b>{campaign.stats.retrying}</b>
              </span>
              <span>Yaratildi: {formatDateTime(campaign.createdAt)}</span>
            </div>
            <div className="flex gap-2">
              <Link href={`/dev/triggers?tab=logs&campaign=${campaign.id}`} className={secondaryButton}>
                Loglar
              </Link>
              <Link href={`/dev/triggers/${campaign.id}`} className={secondaryButton}>
                Tahrirlash
              </Link>
              <button type="button" className={secondaryButton} disabled={busy === campaign.id} onClick={() => void remove(campaign)}>
                O&apos;chirish
              </button>
            </div>
          </div>
        </div>
      ))}
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

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dev/triggers/contacts?page=${page}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data.success) return;
        setContacts(data.data.contacts);
        setTotalPages(data.data.pagination.totalPages);
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  if (!contacts) return <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>;
  if (contacts.length === 0) {
    return (
      <div className="panel rounded-xl">
        <EmptyState title="Hali kontakt yo'q" body="Birinchi story reply kelganda kontakt avtomatik yaratiladi." />
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

interface SimulationResult {
  selected: { id: string; name: string; matchedKeyword: string | null; responseMessage: string } | null;
  ignoredReason: string | null;
  campaigns: Array<{ id: string; name: string; matched: boolean; matchedKeyword: string | null; reason: string | null }>;
}

function SimulatorTab({ accounts }: { accounts: Account[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [text, setText] = useState("Narxi qancha?");
  const [storyId, setStoryId] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    const res = await fetch("/api/dev/triggers/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId: accountId, text, storyId: storyId.trim() || null }),
    });
    const data = await res.json();
    setRunning(false);
    if (data.success) setResult(data.data);
    else setError(data.error ?? "Xato");
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="panel space-y-4 rounded-xl p-4">
        <p className="text-sm text-muted">
          Story reply kelganda engine qaysi campaign&apos;ni tanlashini tekshiradi. Hech narsa yuborilmaydi va saqlanmaydi.
        </p>
        <Field label="Akkaunt">
          <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reply matni">
          <textarea className={`${inputClass} min-h-20`} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label="Story ID (ixtiyoriy)" hint="Specific story campaignlarni tekshirish uchun">
          <input className={inputClass} value={storyId} onChange={(e) => setStoryId(e.target.value)} />
        </Field>
        <button type="button" onClick={() => void run()} disabled={running || !accountId} className={primaryButton}>
          {running ? "Tekshirilmoqda…" : "Tekshirish"}
        </button>
        {error && <p className="text-sm text-error">{error}</p>}
      </div>

      <div className="panel rounded-xl p-4">
        {!result ? (
          <EmptyState title="Natija shu yerda" />
        ) : (
          <div className="space-y-4 text-sm">
            {result.selected ? (
              <div className="rounded-lg border border-success/30 bg-success/5 p-3">
                <p className="font-semibold text-success">✓ {result.selected.name} javob beradi</p>
                {result.selected.matchedKeyword && (
                  <p className="mt-1 text-muted">Kalit so&apos;z: {result.selected.matchedKeyword}</p>
                )}
                <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-surface-hover px-2 py-1.5 text-foreground">
                  {result.selected.responseMessage}
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-border p-3">
                <p className="font-semibold text-foreground">Ignored</p>
                <p className="mt-1 text-muted">{result.ignoredReason}</p>
              </div>
            )}
            {result.campaigns.length > 0 && (
              <ul className="space-y-1.5">
                {result.campaigns.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <span className="truncate text-foreground">{c.name}</span>
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
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [c, o] = await Promise.all([
      fetch("/api/dev/triggers/campaigns").then((r) => r.json()).catch(() => null),
      fetch("/api/dev/triggers/overview").then((r) => r.json()).catch(() => null),
    ]);
    if (c?.success) {
      setCampaigns(c.data.campaigns);
      setAccounts(c.data.accounts);
    }
    if (o?.success) setOverview(o.data);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const setTab = (next: Tab) => router.replace(`/dev/triggers?tab=${next}`, { scroll: false });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Instagram Triggers</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Event engine · Story Reply → Contact → Conversation → Auto javob → Log → Retry
          </p>
        </div>
        <Link href="/dev/triggers/new" className={primaryButton}>
          + Automation yaratish
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
        <CampaignsTab campaigns={campaigns} accounts={accounts} onChanged={() => void load()} />
      ) : tab === "logs" ? (
        <TriggerLogs key={searchParams.get("campaign") ?? ""} campaigns={campaigns} initialCampaignId={searchParams.get("campaign") ?? ""} />
      ) : tab === "contacts" ? (
        <ContactsTab />
      ) : (
        <SimulatorTab accounts={accounts} />
      )}
    </div>
  );
}
