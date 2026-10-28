"use client";

/**
 * Ads (Meta). The AI only proposes; every launch and resume is the owner's
 * click, after the caps are set. Two tabs: proposals / campaigns (approve with
 * budget and days, reject, pause, resume) and ad accounts (caps, CPL limit,
 * Page / IG / dataset ids). Everything is created PAUSED on Meta's side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Field, inputClass } from "@/components/assistant-ui";
import { Card, EmptyState, Label, PageHeader } from "@/components/ui/page";
import { FlashNotice, Tabs, formatDateTime } from "@/components/channels/ui";
import { takeFlash, type Flash } from "@/lib/flash";
import { jsonInit, requestJson } from "@/lib/request-json";

const API = "/api/ads";

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

type Tone = "success" | "warning" | "error" | "muted";
type Act = (body: Record<string, unknown>, ok: string) => Promise<boolean>;

const STATUS: Record<string, { label: string; tone: Tone }> = {
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
    // Strict Mode runs effects twice: the second read finds the cookie gone and must not wipe the notice.
    const flash = takeFlash();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration
    if (flash) setNotice(flash);
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    void load();
  }, [load]);

  const act: Act = async (body, ok) => {
    setNotice(null);
    const res = await requestJson(API, jsonInit("POST", body));
    setNotice(res.ok ? { tone: "success", text: ok } : { tone: "error", text: res.error });
    if (res.ok) await load();
    return res.ok;
  };

  const isOwner = data?.role === "OWNER";
  const proposed = data?.proposals.filter((p) => p.status === "PROPOSED").length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        description="AI faqat taklif qiladi. Har bir sarf egasining tasdig'i bilan boshlanadi, kunlik va oylik chegara hamda lid narxi oshsa reklama o'zi to'xtaydi."
        actions={
          <>
            {isOwner && (
              <a className="btn btn-sm btn-lime" href="/api/ads/connect">
                {data && data.accounts.length > 0 ? "Yana akkaunt ulash" : "Meta reklama akkauntini ulash"}
              </a>
            )}
            <Button tone="ghost" disabled={loading} onClick={() => void load()}>
              {loading ? "Yangilanmoqda…" : "Yangilash"}
            </Button>
          </>
        }
      />

      <FlashNotice flash={notice} />
      {data && !isOwner && <FlashNotice flash={{ tone: "warning", text: "Tasdiqlash va chegaralarni faqat workspace egasi o'zgartiradi. Siz ko'ra olasiz va reklamani to'xtata olasiz." }} />}

      <Tabs tabs={[["proposals", "Takliflar va kampaniyalar", proposed], ["accounts", "Akkauntlar va chegaralar"]]} value={tab} onChange={setTab} />

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

function ProposalsTab({ data, act, isOwner }: { data: Data; act: Act; isOwner: boolean }) {
  if (data.proposals.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Hali taklif yo'q"
          body={data.accounts.length === 0 ? "Avval Meta reklama akkauntini ulang. Post akkaunt medianasidan 2× yaxshi ishlasa, taklif shu yerda paydo bo'ladi." : "Post akkaunt medianasidan 2× yaxshi ishlasa, boost taklifi shu yerda paydo bo'ladi."}
        />
      </Card>
    );
  }
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
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status.tone}>{status.label}</Badge>
        {p.pauseReason && <span className="text-xs text-muted">sabab: {PAUSE[p.pauseReason] ?? p.pauseReason}</span>}
        <span className="text-xs text-muted">{account?.name ?? account?.adAccountId}</span>
        {p.permalink && (
          <a className="text-xs font-semibold text-lime hover:underline" href={p.permalink} target="_blank" rel="noreferrer">
            Postni ochish
          </a>
        )}
      </div>
      <p className="mt-3 text-[15px] leading-6 text-white">{p.reason}</p>

      <div className="inset mt-4 grid gap-3 p-4 sm:grid-cols-4">
        <Stat label="Byudjet" value={`${money(p.dailyBudgetMinor, account)} / kun`} />
        <Stat label="Muddat" value={`${p.durationDays} kun`} />
        <Stat label="Maqsad" value={p.objective === "MESSAGES" ? "DM'ga yo'naltirish" : "Faollik"} />
        {p.status !== "PROPOSED" ? <Stat label="Sarf · natija · CPL" value={`${money(p.spendMinor, account)} · ${p.results} · ${cpl}`} /> : <Stat label="Taklif amal qiladi" value={p.expiresAt ? `${formatDateTime(p.expiresAt)} gacha` : "—"} />}
      </div>
      {p.endAt && <p className="mt-2 text-xs text-muted">Tugaydi: {formatDateTime(p.endAt)}</p>}
      {p.error && <p className="mt-2 break-words text-xs text-error">{p.error}</p>}

      {p.status === "PROPOSED" && account && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="space-y-1.5 text-xs font-semibold text-muted">
            Kunlik ({account.currency})
            <input className={`${inputClass} w-28`} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label className="space-y-1.5 text-xs font-semibold text-muted">
            Kun
            <input className={`${inputClass} w-20`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <select className={`${inputClass} w-auto`} value={objective} onChange={(e) => setObjective(e.target.value as Proposal["objective"])} aria-label="Maqsad">
            <option value="MESSAGES">DM&apos;ga yo&apos;naltirish</option>
            <option value="ENGAGEMENT">Faollik</option>
          </select>
          <Button
            tone="lime"
            disabled={!isOwner}
            onClick={() => void act({ action: "approve", id: p.id, dailyBudgetMinor: toMinor(budget, account), durationDays: Number(days), objective }, "Reklama ishga tushdi")}
          >
            Tasdiqlash va ishga tushirish
          </Button>
          <Button tone="ghost" onClick={() => void act({ action: "reject", id: p.id }, "Rad etildi")}>
            Rad etish
          </Button>
        </div>
      )}
      {p.status === "LIVE" && (
        <div className="mt-4">
          <Button tone="ghost" onClick={() => void act({ action: "pause", id: p.id }, "To'xtatildi")}>
            To&apos;xtatish
          </Button>
        </div>
      )}
      {p.status === "PAUSED" && (
        <div className="mt-4">
          <Button tone="lime" disabled={!isOwner} onClick={() => void act({ action: "resume", id: p.id }, "Davom ettirildi")}>
            Davom ettirish
          </Button>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <p className="mt-1 break-words text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function AccountsTab({ data, act, isOwner }: { data: Data; act: Act; isOwner: boolean }) {
  if (data.accounts.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Reklama akkaunti ulanmagan"
          body="Meta reklama akkauntini ulang. Ilova reklamani faqat to'xtatilgan holatda yaratadi, ishga tushirish esa sizning tasdig'ingiz bilan bo'ladi."
          action={
            isOwner ? (
              <a className="btn btn-sm btn-lime" href="/api/ads/connect">
                Meta reklama akkauntini ulash
              </a>
            ) : undefined
          }
        />
      </Card>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {data.accounts.map((a) => (
        <AccountCard key={a.id} account={a} act={act} isOwner={isOwner} />
      ))}
    </div>
  );
}

/** Spend against its cap; the bar turns warning past 80 % and error at the cap. */
function SpendMeter({ label, spent, cap, account }: { label: string; spent: number; cap: number | null; account: Account }) {
  const ratio = cap && cap > 0 ? Math.min(spent / cap, 1) : 0;
  const tone = ratio >= 1 ? "bg-error" : ratio >= 0.8 ? "bg-warning" : "bg-lime";
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-muted">{label}</span>
        <span className="text-white">
          {money(spent, account)} <span className="text-muted">/ {cap === null ? "chegara yo'q" : money(cap, account)}</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label={label}>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
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
    <Field label={label}>
      <input className={inputClass} value={form[key]} onChange={set(key)} disabled={!isOwner} inputMode={key.endsWith("Id") ? "numeric" : "decimal"} />
    </Field>
  );
  const capsMissing = a.dailyCapMinor === null || a.monthlyCapMinor === null || a.cplMaxMinor === null;

  return (
    <Card
      title={a.name ?? a.adAccountId}
      description={a.adAccountId}
      action={<Badge tone={a.status === "ACTIVE" ? "success" : "error"}>{a.status === "ACTIVE" ? "Ulangan" : "Qayta ulang"}</Badge>}
      className="space-y-5"
    >
      <div className="inset space-y-4 p-4">
        <SpendMeter label="Bugun" spent={a.todaySpentMinor} cap={a.dailyCapMinor} account={a} />
        <SpendMeter label="Shu oy" spent={a.monthSpentMinor} cap={a.monthlyCapMinor} account={a} />
      </div>
      {capsMissing && <FlashNotice flash={{ tone: "warning", text: "Chegaralar belgilanmaguncha hech qanday reklama tasdiqlanmaydi." }} />}
      {a.lastError && <p className="break-words text-sm text-error">{a.lastError}</p>}

      <div>
        <Label>Xavfsizlik chegaralari</Label>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {field("daily", `Kunlik (${a.currency})`)}
          {field("monthly", `Oylik (${a.currency})`)}
          {field("cpl", `Maks. lid narxi (${a.currency})`)}
        </div>
      </div>
      <div>
        <Label>Takliflar</Label>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {field("budget", "Taklif byudjeti / kun")}
          {field("sale", "O'rtacha sotuv (CAPI)")}
        </div>
      </div>
      <div>
        <Label>Bog&apos;langan akkauntlar</Label>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {field("pageId", "Facebook sahifa ID")}
          {field("igUserId", "Instagram ID")}
          {field("datasetId", "Dataset (pixel) ID")}
        </div>
      </div>

      {isOwner && (
        <div className="flex flex-wrap gap-2">
          <Button
            tone="lime"
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
          </Button>
          <Button tone="danger" onClick={() => void act({ action: "revoke", id: a.id }, "Akkaunt uzildi")}>
            Uzish
          </Button>
        </div>
      )}
    </Card>
  );
}
