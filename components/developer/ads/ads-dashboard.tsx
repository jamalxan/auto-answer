"use client";

/**
 * Audit phase 7 — ads, the developer screen. The AI only proposes; every
 * launch and resume is the owner's click, after the caps are set. Two tabs:
 * proposals / campaigns (approve with budget and days, reject, pause,
 * resume) and ad accounts (caps, CPL limit, Page / IG / dataset ids).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { takeFlash, type Flash } from "@/lib/developer/flash";
import { jsonInit, requestJson } from "@/components/developer/comments/shared";
import { DevBadge, Pill, formatDateTime, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";

const API = "/api/developer/ads";

interface Account {
  id: string;
  adAccountId: string;
  name: string | null;
  currency: string;
  offset: number;
  pageId: string | null;
  igUserId: string | null;
  datasetId: string | null;
  dailyCapMinor: number | null;
  monthlyCapMinor: number | null;
  cplMaxMinor: number | null;
  defaultDailyBudgetMinor: number | null;
  saleValueMinor: number | null;
  status: string;
  lastError: string | null;
  todaySpentMinor: number;
  monthSpentMinor: number;
}

interface Proposal {
  id: string;
  accountId: string;
  objective: "MESSAGES" | "ENGAGEMENT";
  igMediaId: string;
  permalink: string | null;
  reason: string;
  dailyBudgetMinor: number;
  durationDays: number;
  status: string;
  pauseReason: string | null;
  spendMinor: number;
  results: number;
  endAt: string | null;
  error: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface Data {
  accounts: Account[];
  proposals: Proposal[];
  role: string;
}

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "error" | "muted" }> = {
  PROPOSED: { label: "Taklif", tone: "warning" },
  LAUNCHING: { label: "Ishga tushmoqda", tone: "warning" },
  LIVE: { label: "Ishlayapti", tone: "success" },
  PAUSED: { label: "To'xtatilgan", tone: "muted" },
  DONE: { label: "Tugadi", tone: "muted" },
  REJECTED: { label: "Rad etildi", tone: "muted" },
  EXPIRED: { label: "Muddati o'tdi", tone: "muted" },
  FAILED: { label: "Xato", tone: "error" },
};
const PAUSE: Record<string, string> = { daily_cap: "kunlik chegara", monthly_cap: "oylik chegara", cpl: "lid narxi yuqori", owner: "qo'lda" };

const money = (minor: number | null, account: Account | undefined) =>
  minor === null || !account ? "—" : `${(minor / account.offset).toFixed(account.offset === 1 ? 0 : 2)} ${account.currency}`;
const toMinor = (major: string, account: Account) => (major.trim() === "" ? null : Math.round(Number(major) * account.offset));
const toMajor = (minor: number | null, account: Account) => (minor === null ? "" : String(minor / account.offset));

export default function AdsDashboard() {
  const [tab, setTab] = useState<"proposals" | "accounts">("proposals");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Flash | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const res = await requestJson<Data>(API);
    if (mine !== seq.current) return;
    if (res.ok) setData(res.data);
    else setNotice({ tone: "error", text: res.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    // The OAuth outcome arrives in a one-shot cookie (never the URL); drop any stale query string.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration
    setNotice(takeFlash());
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    void load();
  }, [load]);

  const act = async (body: Record<string, unknown>, ok: string) => {
    setNotice(null);
    const res = await requestJson(API, jsonInit("POST", body));
    setNotice(res.ok ? { tone: "success", text: ok } : { tone: "error", text: res.error });
    if (res.ok) await load();
    return res.ok;
  };

  const isOwner = data?.role === "OWNER";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Reklama</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">AI faqat taklif qiladi: har bir sarf egasining tasdig&apos;i bilan, kunlik / oylik chegara va CPL bo&apos;yicha avto-pauza.</p>
        </div>
        <div className="flex gap-2">
          <a className={primaryButton} href="/api/developer/ads/connect">
            Meta reklama akkauntini ulash
          </a>
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${notice.tone === "error" ? "border-error/30 bg-error/10 text-error" : "border-success/30 bg-success/10 text-success"}`}>{notice.text}</div>
      )}
      {data && !isOwner && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">Tasdiqlash va chegaralarni faqat workspace egasi o&apos;zgartiradi. Siz to&apos;xtata olasiz.</div>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {(
          [
            ["proposals", "Takliflar va kampaniyalar"],
            ["accounts", "Akkauntlar va chegaralar"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {!data ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : tab === "proposals" ? (
        <ProposalsTab data={data} act={act} isOwner={isOwner} />
      ) : (
        <AccountsTab data={data} act={act} isOwner={isOwner} />
      )}
    </div>
  );
}

type Act = (body: Record<string, unknown>, ok: string) => Promise<boolean>;

function ProposalsTab({ data, act, isOwner }: { data: Data; act: Act; isOwner: boolean }) {
  if (data.proposals.length === 0) return <p className="py-6 text-center text-sm text-muted">Hali taklif yo&apos;q. Post akkaunt medianasidan 2× yaxshi ishlasa, shu yerda paydo bo&apos;ladi.</p>;
  return (
    <div className="space-y-3">
      {data.proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} account={data.accounts.find((a) => a.id === p.accountId)} act={act} isOwner={isOwner} />
      ))}
    </div>
  );
}

function ProposalCard({ proposal: p, account, act, isOwner }: { proposal: Proposal; account: Account | undefined; act: Act; isOwner: boolean }) {
  const [budget, setBudget] = useState(account ? toMajor(p.dailyBudgetMinor, account) : "");
  const [days, setDays] = useState(String(p.durationDays));
  const [objective, setObjective] = useState(p.objective);
  const status = STATUS[p.status] ?? { label: p.status, tone: "muted" as const };
  const cpl = p.results ? money(Math.round(p.spendMinor / p.results), account) : "—";

  return (
    <div className="panel space-y-2 rounded-xl p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={status.tone}>{status.label}</Pill>
        {p.pauseReason && <span className="text-xs text-muted">sabab: {PAUSE[p.pauseReason] ?? p.pauseReason}</span>}
        <span className="text-xs text-muted">{account?.name ?? account?.adAccountId}</span>
        {p.permalink && (
          <a className="text-xs text-accent underline" href={p.permalink} target="_blank" rel="noreferrer">
            Post
          </a>
        )}
      </div>
      <p className="text-foreground">{p.reason}</p>
      <p className="text-xs text-muted">
        Kuniga {money(p.dailyBudgetMinor, account)} · {p.durationDays} kun · {p.objective === "MESSAGES" ? "DM'ga yo'naltirish" : "faollik"}
        {p.status !== "PROPOSED" && ` · sarf ${money(p.spendMinor, account)} · natija ${p.results} · CPL ${cpl}`}
        {p.endAt && ` · tugaydi ${formatDateTime(p.endAt)}`}
        {p.status === "PROPOSED" && p.expiresAt && ` · taklif ${formatDateTime(p.expiresAt)} gacha`}
      </p>
      {p.error && <p className="break-words text-xs text-error">{p.error}</p>}

      {p.status === "PROPOSED" && account && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            Kunlik ({account.currency})
            <input className={`${inputClass} w-28`} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label className="text-xs text-muted">
            Kun
            <input className={`${inputClass} w-20`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <select className={`${inputClass} w-auto`} value={objective} onChange={(e) => setObjective(e.target.value as Proposal["objective"])} aria-label="Maqsad">
            <option value="MESSAGES">DM&apos;ga yo&apos;naltirish</option>
            <option value="ENGAGEMENT">Faollik</option>
          </select>
          <button
            type="button"
            className={primaryButton}
            disabled={!isOwner}
            onClick={() => void act({ action: "approve", id: p.id, dailyBudgetMinor: toMinor(budget, account), durationDays: Number(days), objective }, "Reklama ishga tushdi")}
          >
            Tasdiqlash va ishga tushirish
          </button>
          <button type="button" className={secondaryButton} onClick={() => void act({ action: "reject", id: p.id }, "Rad etildi")}>
            Rad etish
          </button>
        </div>
      )}
      {p.status === "LIVE" && (
        <button type="button" className={secondaryButton} onClick={() => void act({ action: "pause", id: p.id }, "To'xtatildi")}>
          To&apos;xtatish
        </button>
      )}
      {p.status === "PAUSED" && (
        <button type="button" className={secondaryButton} disabled={!isOwner} onClick={() => void act({ action: "resume", id: p.id }, "Davom ettirildi")}>
          Davom ettirish (tasdiq)
        </button>
      )}
    </div>
  );
}

function AccountsTab({ data, act, isOwner }: { data: Data; act: Act; isOwner: boolean }) {
  if (data.accounts.length === 0) return <p className="py-6 text-center text-sm text-muted">Reklama akkaunti ulanmagan.</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {data.accounts.map((a) => (
        <AccountCard key={a.id} account={a} act={act} isOwner={isOwner} />
      ))}
    </div>
  );
}

function AccountCard({ account: a, act, isOwner }: { account: Account; act: Act; isOwner: boolean }) {
  const [form, setForm] = useState({
    pageId: a.pageId ?? "",
    igUserId: a.igUserId ?? "",
    datasetId: a.datasetId ?? "",
    daily: toMajor(a.dailyCapMinor, a),
    monthly: toMajor(a.monthlyCapMinor, a),
    cpl: toMajor(a.cplMaxMinor, a),
    budget: toMajor(a.defaultDailyBudgetMinor, a),
    sale: toMajor(a.saleValueMinor, a),
  });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  const field = (key: keyof typeof form, label: string) => (
    <label className="text-xs text-muted">
      {label}
      <input className={inputClass} value={form[key]} onChange={set(key)} disabled={!isOwner} />
    </label>
  );
  const capsMissing = a.dailyCapMinor === null || a.monthlyCapMinor === null || a.cplMaxMinor === null;

  return (
    <div className="panel space-y-3 rounded-xl p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-semibold text-foreground">{a.name ?? a.adAccountId}</p>
          <p className="text-xs text-muted">
            {a.adAccountId} · bugun {money(a.todaySpentMinor, a)} · shu oy {money(a.monthSpentMinor, a)}
          </p>
        </div>
        <Pill tone={a.status === "ACTIVE" ? "success" : "error"}>{a.status === "ACTIVE" ? "Ulangan" : "Xato"}</Pill>
      </div>
      {capsMissing && <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">Chegaralar belgilanmaguncha hech qanday reklama tasdiqlanmaydi.</div>}
      {a.lastError && <p className="break-words text-xs text-error">{a.lastError}</p>}
      <div className="grid gap-2 sm:grid-cols-3">
        {field("daily", `Kunlik chegara (${a.currency})`)}
        {field("monthly", `Oylik chegara (${a.currency})`)}
        {field("cpl", `Maks. lid narxi (${a.currency})`)}
        {field("budget", "Taklif byudjeti / kun")}
        {field("sale", "O'rtacha sotuv (CAPI)")}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {field("pageId", "Facebook sahifa ID")}
        {field("igUserId", "Instagram ID")}
        {field("datasetId", "Dataset (pixel) ID")}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primaryButton}
          disabled={!isOwner}
          onClick={() =>
            void act(
              {
                action: "settings",
                id: a.id,
                pageId: form.pageId,
                igUserId: form.igUserId,
                datasetId: form.datasetId,
                dailyCapMinor: toMinor(form.daily, a),
                monthlyCapMinor: toMinor(form.monthly, a),
                cplMaxMinor: toMinor(form.cpl, a),
                defaultDailyBudgetMinor: toMinor(form.budget, a),
                saleValueMinor: toMinor(form.sale, a),
              },
              "Saqlandi"
            )
          }
        >
          Saqlash
        </button>
        <button type="button" className={secondaryButton} onClick={() => void act({ action: "revoke", id: a.id }, "Uzildi")}>
          Uzish
        </button>
      </div>
    </div>
  );
}
