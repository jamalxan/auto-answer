"use client";

/**
 * ETAP 4 — JavobAI, the developer screen. One account picker shared by the
 * tabs that work per account (knowledge, test), tabs in the URL so a link
 * opens the right one, and nothing hidden: the kill switch and every
 * account's mode are on the first screen.
 */

import { ServerOffNotice } from "@/components/developer/server-off";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DevBadge, inputClass, Pill, secondaryButton } from "@/components/developer/ui";
import AccountsTab from "./accounts-tab";
import ConversationsTab from "./conversations-tab";
import HandoffTab from "./handoff-tab";
import KnowledgeTab from "./knowledge-tab";
import LadderTab from "./ladder-tab";
import SandboxTab from "./sandbox-tab";
import ScoringTab from "./scoring-tab";
import ShadowTab from "./shadow-tab";
import UsageTab from "./usage-tab";
import { JAVOBAI_API, MODE_TEXT, requestJson, type AccountsResponse, type AccountView } from "./shared";

const TABS = [
  ["accounts", "Akkauntlar"],
  ["knowledge", "Bilim bazasi"],
  ["scoring", "Scoring"],
  ["handoff", "Handoff"],
  ["conversations", "Suhbatlar"],
  ["shadow", "Shadow"],
  ["ladder", "Ishonch zinapoyasi"],
  ["test", "Test"],
  ["usage", "Xarajat"],
] as const;
type Tab = (typeof TABS)[number][0];

const PER_ACCOUNT_TABS: Tab[] = ["knowledge", "test", "ladder"];

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="panel min-w-0 rounded-xl px-4 py-3">
      <p className="label-mono break-words text-[10px] font-semibold text-muted">{label}</p>
      <p className={`mt-1 break-words text-xl font-bold leading-tight ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

export default function JavobAiDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: Tab = TABS.some(([key]) => key === tabParam) ? (tabParam as Tab) : "accounts";
  const accountParam = searchParams.get("account");
  const conversationParam = searchParams.get("conversation");

  const [data, setData] = useState<AccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const res = await requestJson<AccountsResponse>(`${JAVOBAI_API}/accounts`);
      if (mine !== seq.current) return;
      if (res.ok) setData(res.data);
      else setFailure(res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
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

  const accounts = data?.accounts ?? [];
  const account: AccountView | null =
    accounts.find((a) => a.id === accountParam) ?? accounts.find((a) => a.mode !== "OFF") ?? accounts[0] ?? null;

  const navigate = (next: { tab?: Tab; account?: string | null; conversation?: string | null }) => {
    const params = new URLSearchParams();
    params.set("tab", next.tab ?? tab);
    const accountId = next.account === undefined ? account?.id : next.account;
    if (accountId) params.set("account", accountId);
    if (next.conversation) params.set("conversation", next.conversation);
    router.replace(`/developer/javobai?${params.toString()}`, { scroll: false });
  };

  const live = accounts.filter((a) => a.mode === "LIVE").length;
  const shadow = accounts.filter((a) => a.mode === "SHADOW").length;
  const withProfile = accounts.filter((a) => a.profile.live).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">JavobAI</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Bilim bazasi → AI sotuv agenti → lead scoring → operatorga topshirish. Akkaunt bo&apos;yicha OFF / SHADOW / LIVE.
          </p>
        </div>
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
          {loading ? "Yangilanmoqda…" : "Yangilash"}
        </button>
      </div>

      {failure && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span className="min-w-0 break-words">{failure}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      {data?.disabled && (
        <ServerOffNotice
          what="JavobAI serverda to'xtatilgan: har bir akkaunt, rejimidan qat'i nazar, oddiy assistent orqali javob beradi."
          ops={<><code>JAVOBAI_DISABLED</code> ni o&apos;chirib, web va worker&apos;ni qayta ishga tushiring.</>}
        />
      )}

      {data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Akkauntlar" value={accounts.length} />
          <Stat label="LIVE" value={live} tone={live ? "text-success" : undefined} />
          <Stat label="SHADOW" value={shadow} tone={shadow ? "text-warning" : undefined} />
          <Stat
            label="Tayyor profil"
            value={`${withProfile}/${accounts.length}`}
            tone={withProfile < accounts.length ? "text-warning" : undefined}
          />
        </div>
      ) : (
        <div className="h-[74px]" />
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => navigate({ tab: key })}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {PER_ACCOUNT_TABS.includes(tab) && accounts.length > 0 && account && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="label-mono text-[11px] font-semibold text-muted" htmlFor="javobai-account">
            Akkaunt
          </label>
          <select
            id="javobai-account"
            className={`${inputClass} w-auto min-w-[12rem]`}
            value={account.id}
            onChange={(e) => navigate({ account: e.target.value })}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username} · {a.mode}
              </option>
            ))}
          </select>
          <Pill tone={MODE_TEXT[account.mode].tone}>{account.mode}</Pill>
          {!account.profile.live && <Pill tone="warning">Profil tayyor emas</Pill>}
        </div>
      )}

      {!data ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : tab === "accounts" ? (
        <AccountsTab data={data} onChanged={() => void load()} />
      ) : tab === "knowledge" ? (
        <KnowledgeTab account={account} />
      ) : tab === "scoring" ? (
        <ScoringTab />
      ) : tab === "handoff" ? (
        <HandoffTab onOpenConversation={(id) => navigate({ tab: "conversations", conversation: id })} />
      ) : tab === "conversations" ? (
        <ConversationsTab accounts={accounts} initialConversationId={conversationParam} />
      ) : tab === "shadow" ? (
        <ShadowTab />
      ) : tab === "ladder" ? (
        <LadderTab account={account} />
      ) : tab === "test" ? (
        <SandboxTab account={account} />
      ) : (
        <UsageTab />
      )}
    </div>
  );
}
