"use client";

/**
 * Audit phase 8 — tariffs, the developer screen: the current plan and its
 * usage, the four plans with so'm prices, checkout through Click / Payme
 * (only the providers switched on) and the payment history.
 */

import { useCallback, useEffect, useState } from "react";
import { jsonInit, requestJson } from "@/components/developer/comments/shared";
import { DevBadge, Pill, formatDateTime, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";

const API = "/api/billing";

interface Limits {
  channels: number;
  aiReplies: number;
  aiAuto: boolean;
  managers: number;
  scheduledPostsPerMonth: number;
  videoAnalysesPerMonth: number;
  contentPlan: boolean;
  crmIntegrations: boolean;
  clientReports: boolean;
}

interface Plan {
  slug: string;
  name: string;
  priceUsd: number;
  priceUzs: number;
  audience: string;
  limits: Limits;
}

interface Data {
  usage: { plan: Plan; enforced: boolean; channels: number; aiReplies: number; scheduledPosts: number; videoAnalyses: number };
  planExpiresAt: string | null;
  plans: Plan[];
  providers: Array<"PAYME" | "CLICK">;
  payments: Array<{ id: string; plan: string; months: number; amountTiyin: number; provider: string; status: string; performedAt: string | null; createdAt: string }>;
  role: string;
}

const som = (n: number) => `${n.toLocaleString("uz-UZ").replace(/,/g, " ")} so'm`;

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className={used >= limit ? "text-error" : ""}>
          {used} / {limit}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div className={`h-full ${used >= limit ? "bg-error" : "bg-accent"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function BillingDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [months, setMonths] = useState(1);

  const load = useCallback(async () => {
    const res = await requestJson<Data>(API);
    if (res.ok) setData(res.data);
    else setNotice({ tone: "error", text: res.error });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const pay = async (plan: string, provider: string) => {
    setNotice(null);
    const res = await requestJson<{ url: string }>(API, jsonInit("POST", { plan, months, provider }));
    if (res.ok) window.location.assign(res.data.url);
    else setNotice({ tone: "error", text: res.error });
  };

  if (!data) return <p className="py-10 text-center text-sm text-muted">{notice?.text ?? "Yuklanmoqda…"}</p>;
  const { usage } = data;
  const limits = usage.plan.limits;
  const canPay = data.role === "OWNER" || data.role === "ADMIN";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Tariflar</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">Narx kanallar, AI javoblar va video tahlil bo&apos;yicha. To&apos;lov so&apos;mda, Click va Payme orqali.</p>
        </div>
        <button type="button" className={secondaryButton} onClick={() => void load()}>
          Yangilash
        </button>
      </div>

      {notice && <div className={`rounded-lg border px-3 py-2 text-sm ${notice.tone === "error" ? "border-error/30 bg-error/10 text-error" : "border-success/30 bg-success/10 text-success"}`}>{notice.text}</div>}
      {!usage.enforced && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Limitlar hozircha faqat ko&apos;rsatiladi (<code>BILLING_ENFORCED</code> o&apos;chiq) — hech kim bloklanmaydi.
        </div>
      )}

      <div className="panel space-y-3 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold text-foreground">Joriy tarif: {usage.plan.name}</p>
          {data.planExpiresAt && <Pill tone="muted">{formatDateTime(data.planExpiresAt)} gacha</Pill>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Meter label="Kanallar" used={usage.channels} limit={limits.channels} />
          <Meter label="AI suhbatlar (oy)" used={usage.aiReplies} limit={limits.aiReplies} />
          <Meter label="Rejalashtirilgan post (oy)" used={usage.scheduledPosts} limit={limits.scheduledPostsPerMonth} />
          <Meter label="Video tahlil (oy)" used={usage.videoAnalyses} limit={limits.videoAnalysesPerMonth} />
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted">Muddat:</span>
        <select className={`${inputClass} w-auto`} value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Muddat">
          {[1, 3, 6, 12].map((m) => (
            <option key={m} value={m}>
              {m} oy
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {data.plans.map((plan) => {
          const current = plan.slug === usage.plan.slug;
          return (
            <div key={plan.slug} className={`panel flex flex-col gap-3 rounded-xl p-4 text-sm ${current ? "ring-2 ring-accent" : ""}`}>
              <div>
                <p className="font-semibold text-foreground">{plan.name}</p>
                <p className="text-xs text-muted">{plan.audience}</p>
              </div>
              <p className="font-display text-xl font-extrabold text-foreground">
                {plan.priceUzs ? som(plan.priceUzs) : "Bepul"}
                {plan.priceUzs > 0 && <span className="text-xs font-normal text-muted"> / oy · ${plan.priceUsd}</span>}
              </p>
              <ul className="space-y-1 text-xs text-muted">
                <li>{plan.limits.channels} ta kanal</li>
                <li>{plan.limits.aiReplies.toLocaleString("uz-UZ")} AI javob / oy{plan.limits.aiAuto ? ", avto rejim" : " (kuzatish + copilot)"}</li>
                <li>{plan.limits.scheduledPostsPerMonth} ta rejalashtirilgan post / oy</li>
                <li>{plan.limits.videoAnalysesPerMonth ? `${plan.limits.videoAnalysesPerMonth} ta video tahlil / oy` : "Video tahlil yo'q"}</li>
                {plan.limits.managers > 1 && <li>{plan.limits.managers} ta menejer</li>}
                {plan.limits.contentPlan && <li>2 haftalik kontent reja</li>}
                {plan.limits.crmIntegrations && <li>CRM integratsiya</li>}
                {plan.limits.clientReports && <li>Mijozga hisobot, ko&apos;p brend</li>}
              </ul>
              {plan.priceUzs > 0 && (
                <div className="mt-auto space-y-2">
                  {data.providers.length === 0 ? (
                    <p className="text-xs text-muted">To&apos;lov tez orada yoqiladi.</p>
                  ) : (
                    data.providers.map((provider) => (
                      <button key={provider} type="button" className={`${primaryButton} w-full`} disabled={!canPay} onClick={() => void pay(plan.slug, provider)}>
                        {provider === "PAYME" ? "Payme" : "Click"} · {som(plan.priceUzs * months)}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {data.payments.length > 0 && (
        <div className="panel space-y-2 rounded-xl p-4 text-sm">
          <p className="font-semibold text-foreground">To&apos;lovlar</p>
          {data.payments.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 text-xs">
              <Pill tone={p.status === "PAID" ? "success" : p.status === "CANCELED" ? "muted" : "warning"}>{p.status}</Pill>
              <span>
                {p.plan} · {p.months} oy · {som(p.amountTiyin / 100)} · {p.provider}
              </span>
              <span className="text-muted">{formatDateTime(p.performedAt ?? p.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
