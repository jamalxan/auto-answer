"use client";

/**
 * ETAP 9 — Engagement, the developer screen. One /meta call feeds every tab
 * (accounts, Comment 2.0 campaigns, the caller's permissions, rule
 * verifiability, kill switch). Tabs, the open giveaway and the wizard live in
 * the URL (?tab= &giveaway= &new=1) so a link opens the right screen.
 */

import { ServerOffNotice } from "@/components/developer/server-off";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DevBadge, Pill, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import GamificationTab from "./gamification-tab";
import GiveawayTab from "./giveaway-tab";
import ReferralTab from "./referral-tab";
import RulesTab from "./rules-tab";
import { ENGAGEMENT_API, requestJson, type Meta } from "./shared";

const TABS = [
  ["giveaway", "Giveaway"],
  ["referral", "Referral"],
  ["gamification", "Gamification"],
  ["rules", "Qoidalar (Meta)"],
] as const;
export type EngagementTab = (typeof TABS)[number][0];

export interface EngagementNavigate {
  (next: { tab?: EngagementTab; giveaway?: string | null; creating?: boolean }): void;
}

export default function EngagementDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: EngagementTab = TABS.some(([key]) => key === tabParam) ? (tabParam as EngagementTab) : "giveaway";
  const giveawayParam = searchParams.get("giveaway");
  const creating = searchParams.get("new") === "1";

  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const res = await requestJson<Meta>(`${ENGAGEMENT_API}/meta`);
      if (mine !== seq.current) return;
      if (res.ok) setMeta(res.data);
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

  const navigate: EngagementNavigate = (next) => {
    const params = new URLSearchParams();
    const nextTab = next.tab ?? tab;
    params.set("tab", nextTab);
    if (nextTab === "giveaway") {
      const giveaway = next.giveaway === undefined ? (next.tab && next.tab !== tab ? null : giveawayParam) : next.giveaway;
      const wantsNew = next.creating === undefined ? (next.tab && next.tab !== tab ? false : creating) : next.creating;
      if (giveaway) params.set("giveaway", giveaway);
      else if (wantsNew) params.set("new", "1");
    }
    router.replace(`/engagement?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Engagement</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Giveaway adolatli qur&apos;a bilan, do&apos;st taklif qilish (referral) va ball/nishonlar. Hamma narsa ochiq: qaysi shart tekshiriladi, qaysi biri yo&apos;q — o&apos;zingiz ko&apos;rasiz.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {meta && <Pill tone={meta.me.normalizedRole === "VIEWER" ? "muted" : "success"}>{meta.me.roleLabel}</Pill>}
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
        </div>
      </div>

      {failure && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span className="min-w-0 break-words">{failure}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      {meta?.disabled && (
        <ServerOffNotice
          what="Engagement o'chiq: izohlar yig'ilmaydi, referral hisoblanmaydi, g'oliblarga xabar ketmaydi."
          ops={<><code>ENGAGEMENT_DISABLED</code> ni olib tashlang va web hamda worker&apos;ni qayta ishga tushiring.</>}
        />
      )}
      {meta && meta.me.normalizedRole === "VIEWER" && <Notice tone="info">Kuzatuvchi (VIEWER) rolidasiz: hamma narsani ko&apos;rasiz, lekin o&apos;zgartira olmaysiz.</Notice>}
      {meta && meta.me.normalizedRole === "OPERATOR" && (
        <Notice tone="info">Operator rolida ko&apos;rish mumkin; giveaway, qur&apos;a va sozlamalarni Menejer yoki undan yuqori rol boshqaradi.</Notice>
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

      {!meta ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : tab === "giveaway" ? (
        <GiveawayTab meta={meta} giveawayId={giveawayParam} creating={creating} navigate={navigate} />
      ) : tab === "referral" ? (
        <ReferralTab meta={meta} />
      ) : tab === "gamification" ? (
        <GamificationTab meta={meta} />
      ) : (
        <RulesTab />
      )}
    </div>
  );
}
