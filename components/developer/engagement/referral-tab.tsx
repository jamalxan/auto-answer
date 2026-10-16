"use client";

/**
 * "Referral" tab: one program per Instagram account (qualifier, reward,
 * burst limit, on/off), referral codes with copyable links, the events table
 * with fraud flags and approve / reject, and the numbers.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Field, Pill, Toggle, formatDateTime, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Advanced, Notice } from "@/components/developer/comments/parts";
import { ENGAGEMENT_API, copyText, jsonInit, requestJson, type Meta } from "./shared";

type Qualifier = "FIRST_MESSAGE" | "LEAD" | "PURCHASE";

interface Program {
  id: string;
  name: string;
  active: boolean;
  qualifier: Qualifier;
  rewardRules: { tagSlug?: string; points?: number; telegramOwner: boolean; dmTemplate?: string; refereeDmTemplate?: string };
  burstLimitPerDay: number;
}

interface Form {
  name: string;
  active: boolean;
  qualifier: Qualifier;
  tagSlug: string;
  points: string;
  telegramOwner: boolean;
  dmTemplate: string;
  refereeDmTemplate: string;
  burstLimitPerDay: number;
}

interface CodeItem {
  id: string;
  code: string;
  igUserId: string;
  username: string | null;
  events: number;
  qualified: number;
  rewarded: number;
  link: string | null;
}

interface EventItem {
  id: string;
  referrerUsername: string | null;
  referrerIgUserId: string;
  refereeUsername: string | null;
  refereeIgUserId: string;
  status: "PENDING" | "QUALIFIED" | "REWARDED" | "REJECTED";
  fraudFlags: string[];
  createdAt: string;
  rejectReason: string | null;
}

interface Stats {
  totals: { pending: number; qualified: number; rewarded: number; rejected: number; flagged: number; total: number };
  topReferrers: Array<{ referrerIgUserId: string; username: string | null; rewarded: number; qualified: number; total: number }>;
}

interface ContactHit {
  id: string;
  instagramAccountId: string;
  username: string | null;
  name: string | null;
}

const QUALIFIER_TEXT: Record<Qualifier, { title: string; description: string }> = {
  FIRST_MESSAGE: { title: "Do'st birinchi xabarini yozganda", description: "Standart. Havola orqali kelgan odam Direct'ga birinchi marta yozishi bilan taklif hisoblanadi." },
  LEAD: { title: "Do'st telefon raqamini qoldirganda", description: "Taklif lead yig'ilganda hisoblanadi (CRM'dagi lead)." },
  PURCHASE: { title: "Do'st xarid qilganda", description: "Taklif CRM'da bitim «Yutilgan» bo'lganda hisoblanadi." },
};

const EVENT_STATUS: Record<EventItem["status"], { label: string; tone: "success" | "warning" | "error" | "muted" }> = {
  PENDING: { label: "Kutilmoqda", tone: "warning" },
  QUALIFIED: { label: "Hisoblandi", tone: "success" },
  REWARDED: { label: "Mukofotlandi", tone: "success" },
  REJECTED: { label: "Rad etildi", tone: "error" },
};

function toForm(p: Program | null): Form {
  return {
    name: p?.name ?? "Do'st taklif qiling",
    active: p?.active ?? false,
    qualifier: p?.qualifier ?? "FIRST_MESSAGE",
    tagSlug: p?.rewardRules.tagSlug ?? "",
    points: p?.rewardRules.points !== undefined ? String(p.rewardRules.points) : "",
    telegramOwner: p?.rewardRules.telegramOwner ?? true,
    dmTemplate: p?.rewardRules.dmTemplate ?? "",
    refereeDmTemplate: p?.rewardRules.refereeDmTemplate ?? "",
    burstLimitPerDay: p?.burstLimitPerDay ?? 10,
  };
}

function CopyLink({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="text-xs text-accent hover:underline"
      onClick={async () => {
        setDone(await copyText(text));
        setTimeout(() => setDone(false), 2000);
      }}
    >
      {done ? "Nusxalandi" : "Havolani nusxalash"}
    </button>
  );
}

export default function ReferralTab({ meta }: { meta: Meta }) {
  const [accountId, setAccountId] = useState(meta.accounts[0]?.id ?? "");
  const [program, setProgram] = useState<Program | null>(null);
  const [form, setForm] = useState<Form>(toForm(null));
  const [savedForm, setSavedForm] = useState<Form>(toForm(null));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const seq = useRef(0);

  const loadProgram = useCallback(async () => {
    const mine = ++seq.current;
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await requestJson<{ program: Program | null }>(`${ENGAGEMENT_API}/referral/program?accountId=${encodeURIComponent(accountId)}`);
      if (mine !== seq.current) return;
      if (res.ok) {
        setProgram(res.data.program);
        const f = toForm(res.data.program);
        setForm(f);
        setSavedForm(f);
      } else setError(res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on account change
    void loadProgram();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [loadProgram]);

  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm);
  const patch = (next: Partial<Form>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...next }));
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const points = form.points.trim() === "" ? undefined : Number(form.points);
      const res = await requestJson<{ program: Program }>(
        `${ENGAGEMENT_API}/referral/program?accountId=${encodeURIComponent(accountId)}`,
        jsonInit("PUT", {
          name: form.name,
          active: form.active,
          qualifier: form.qualifier,
          burstLimitPerDay: form.burstLimitPerDay,
          rewardRules: {
            telegramOwner: form.telegramOwner,
            ...(form.tagSlug.trim() ? { tagSlug: form.tagSlug.trim() } : {}),
            ...(points !== undefined && Number.isFinite(points) ? { points } : {}),
            ...(form.dmTemplate.trim() ? { dmTemplate: form.dmTemplate.trim() } : {}),
            ...(form.refereeDmTemplate.trim() ? { refereeDmTemplate: form.refereeDmTemplate.trim() } : {}),
          },
        })
      );
      if (res.ok) {
        setProgram(res.data.program);
        const f = toForm(res.data.program);
        setForm(f);
        setSavedForm(f);
        setSaved(true);
      } else setError(res.error);
    } finally {
      setSaving(false);
    }
  }

  const canManage = meta.me.canManage;
  const account = meta.accounts.find((a) => a.id === accountId);

  if (meta.accounts.length === 0) return <EmptyState title="Instagram akkaunt ulanmagan" body="Referral dasturi akkaunt bo'yicha ishlaydi: avval akkaunt ulang." />;

  return (
    <div className="space-y-5">
      <Field label="Instagram akkaunt">
        <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Instagram akkaunt">
          {meta.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.username}
            </option>
          ))}
        </select>
      </Field>

      <section className="panel space-y-4 rounded-xl p-4" aria-label="Referral dasturi">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Dastur {program ? "" : "(hali yaratilmagan)"}</h2>
          {dirty && <Pill tone="warning">Saqlanmagan o&apos;zgarishlar</Pill>}
        </div>
        {loading && <p className="text-xs text-muted">Yuklanmoqda…</p>}
        {error && <Notice tone="error">{error}</Notice>}

        <Field label="Dastur nomi">
          <input className={inputClass} value={form.name} maxLength={80} disabled={!canManage} onChange={(e) => patch({ name: e.target.value })} />
        </Field>

        <fieldset className="space-y-2" disabled={!canManage}>
          <legend className="label-mono mb-1 text-[11px] font-semibold text-muted">Taklif qachon hisoblanadi?</legend>
          {(Object.keys(QUALIFIER_TEXT) as Qualifier[]).map((key) => (
            <label key={key} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${form.qualifier === key ? "border-accent bg-accent/5" : "border-border"}`}>
              <input type="radio" name="qualifier" className="mt-1" checked={form.qualifier === key} onChange={() => patch({ qualifier: key })} />
              <span>
                <span className="block font-medium text-foreground">{QUALIFIER_TEXT[key].title}</span>
                <span className="block text-xs text-muted">{QUALIFIER_TEXT[key].description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mukofot: ball" hint="Taklif qiluvchiga beriladigan ball. Bo'sh — ball berilmaydi.">
            <input type="number" min={0} max={1000} className={inputClass} value={form.points} disabled={!canManage} onChange={(e) => patch({ points: e.target.value })} />
          </Field>
          <Field label="Mukofot: CRM tegi" hint="Masalan: taklifchi. Bo'sh — teg qo'yilmaydi.">
            <input className={inputClass} value={form.tagSlug} maxLength={40} disabled={!canManage} onChange={(e) => patch({ tagSlug: e.target.value })} />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">Har bir mukofot haqida menga Telegram&apos;ga yozing</span>
          <Toggle on={form.telegramOwner} onChange={(telegramOwner) => patch({ telegramOwner })} label="Telegram xabari" />
        </div>

        <Advanced label="Kengaytirilgan (xabar matnlari, kuniga limit)">
          <Field label="Taklif qiluvchiga xabar (faqat 24 soatlik oyna ochiq bo'lsa)" hint="Oyna yopiq bo'lsa Direct yuborilmaydi — mukofot baribir beriladi.">
            <textarea className={inputClass} rows={2} maxLength={500} value={form.dmTemplate} disabled={!canManage} onChange={(e) => patch({ dmTemplate: e.target.value })} />
          </Field>
          <Field label="Taklif qilingan do'stga xabar">
            <textarea className={inputClass} rows={2} maxLength={500} value={form.refereeDmTemplate} disabled={!canManage} onChange={(e) => patch({ refereeDmTemplate: e.target.value })} />
          </Field>
          <Field label="Bir taklif qiluvchidan kuniga ko'pi bilan" hint="Oshib ketsa taklif shubhali deb belgilanadi va sizning tasdig'ingizni kutadi.">
            <input type="number" min={1} max={200} className={inputClass} value={form.burstLimitPerDay} disabled={!canManage} onChange={(e) => patch({ burstLimitPerDay: Math.min(200, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
        </Advanced>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Dastur yoqilgan</p>
            <p className="text-xs text-muted">Yoqilgandan keyingi takliflargina mukofotlanadi; eski yozuvlar tarix bo&apos;lib qoladi.</p>
          </div>
          <Toggle on={form.active} onChange={(active) => patch({ active })} label="Dastur yoqilgan" />
        </div>
        {form.active && (
          <Notice tone="warning">
            Havola (<code>ig.me/m/{account?.username ?? "akkaunt"}?ref=…</code>) yangi suhbatni faqat <b>Icebreakers</b> (salomlashish tugmalari) sozlangan bo&apos;lsa va <b>telefon ilovasida</b>{" "}
            ochadi: Instagram Web&apos;da bu ishlamaydi. Mijoz avval yozgan bo&apos;lsa muammo yo&apos;q.
          </Notice>
        )}
        {saved && <Notice tone="info">Saqlandi.</Notice>}
        <button type="button" className={primaryButton} disabled={saving || !canManage || !dirty || !form.name.trim()} onClick={() => void save()}>
          {saving ? "Saqlanmoqda…" : program ? "Saqlash" : "Dasturni yaratish"}
        </button>
        {!canManage && <p className="text-xs text-muted">O&apos;zgartirish uchun Menejer yoki undan yuqori rol kerak.</p>}
      </section>

      {program && (
        <>
          <StatsPanel programId={program.id} />
          <CodesPanel programId={program.id} accountId={accountId} canManage={canManage} />
          <EventsPanel programId={program.id} canManage={canManage} fraudLabels={meta.labels.fraudFlag} />
        </>
      )}
    </div>
  );
}

function StatsPanel({ programId }: { programId: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    requestJson<Stats>(`${ENGAGEMENT_API}/referral/stats?programId=${encodeURIComponent(programId)}`).then((res) => {
      if (!live) return;
      if (res.ok) setStats(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [programId]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!stats) return null;
  const items: Array<[string, number]> = [
    ["Jami", stats.totals.total],
    ["Mukofotlangan", stats.totals.rewarded],
    ["Kutilmoqda", stats.totals.pending],
    ["Tekshiruv kerak", stats.totals.flagged],
  ];
  return (
    <section className="panel space-y-3 rounded-xl p-4" aria-label="Statistika">
      <h2 className="text-sm font-semibold text-foreground">Natijalar</h2>
      <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border p-3">
            <p className="text-xl font-bold tabular-nums text-foreground">{value}</p>
            <p className="text-xs text-muted">{label}</p>
          </div>
        ))}
      </div>
      {stats.topReferrers.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
          {stats.topReferrers.slice(0, 5).map((r) => (
            <li key={r.referrerIgUserId}>
              {r.username ? `@${r.username}` : r.referrerIgUserId} <span className="text-muted">— {r.rewarded} mukofotlangan, {r.total} taklif</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CodesPanel({ programId, accountId, canManage }: { programId: string; accountId: string; canManage: boolean }) {
  const [codes, setCodes] = useState<CodeItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const seq = useRef(0);
  const searchSeq = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const mine = ++seq.current;
      const params = new URLSearchParams({ programId, limit: "30" });
      if (after) params.set("cursor", after);
      const res = await requestJson<{ items: CodeItem[]; nextCursor: string | null }>(`${ENGAGEMENT_API}/referral/codes?${params}`);
      if (mine !== seq.current) return;
      if (res.ok) {
        setCodes((prev) => (after && prev ? [...prev, ...res.data.items] : res.data.items));
        setCursor(res.data.nextCursor);
        setError(null);
      } else setError(res.error);
    },
    [programId]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load(null);
  }, [load]);

  useEffect(() => {
    const q = search.trim();
    const mine = ++searchSeq.current;
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale hits
      setHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await requestJson<{ items: ContactHit[] }>(`/api/developer/crm/contacts?q=${encodeURIComponent(q.replace(/^@/, ""))}&limit=8`);
        if (mine !== searchSeq.current) return;
        setHits(res.ok ? res.data.items.filter((c) => c.instagramAccountId === accountId) : []);
      } finally {
        if (mine === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search, accountId]);

  async function create(contactId: string) {
    setBusy(contactId);
    setError(null);
    try {
      const res = await requestJson<{ link: string | null }>(`${ENGAGEMENT_API}/referral/codes`, jsonInit("POST", { programId, contactId }));
      if (res.ok) {
        setLastLink(res.data.link);
        setSearch("");
        setHits([]);
        void load(null);
      } else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel space-y-3 rounded-xl p-4" aria-label="Kodlar">
      <h2 className="text-sm font-semibold text-foreground">Taklif kodlari</h2>
      {error && <Notice tone="error">{error}</Notice>}
      {canManage && (
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-muted" htmlFor="ref-contact-search">
            Kontakt uchun kod yaratish
          </label>
          <input id="ref-contact-search" className={inputClass} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Username yoki ism (kamida 2 belgi)" />
          {searching && <p className="text-xs text-muted">Qidirilmoqda…</p>}
          {hits.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {hits.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 break-all text-foreground">{c.username ? `@${c.username}` : c.name ?? c.id}</span>
                  <button type="button" className={secondaryButton} disabled={busy === c.id} onClick={() => void create(c.id)}>
                    {busy === c.id ? "Kuting…" : "Kod yaratish"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {search.trim().length >= 2 && !searching && hits.length === 0 && <p className="text-xs text-muted">Bu akkauntda mos kontakt topilmadi.</p>}
          {lastLink && (
            <Notice tone="info">
              Tayyor havola: <span className="break-all">{lastLink}</span> <CopyLink text={lastLink} />
            </Notice>
          )}
        </div>
      )}
      {codes === null ? (
        <p className="py-4 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : codes.length === 0 ? (
        <EmptyState title="Hali kod yo'q" body="Kontaktni qidirib, unga shaxsiy havola yarating." />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {codes.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="font-semibold text-foreground">{c.username ? `@${c.username}` : c.igUserId}</span>
              <code className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">{c.code}</code>
              <span className="text-xs text-muted">
                {c.events} taklif · {c.qualified} hisoblangan · {c.rewarded} mukofot
              </span>
              {c.link && <CopyLink text={c.link} />}
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button type="button" className={secondaryButton} onClick={() => void load(cursor)}>
          Yana yuklash
        </button>
      )}
    </section>
  );
}

function EventsPanel({ programId, canManage, fraudLabels }: { programId: string; canManage: boolean; fraudLabels: Record<string, string> }) {
  const [status, setStatus] = useState<EventItem["status"] | "">("");
  const [flagged, setFlagged] = useState(false);
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reject, setReject] = useState<{ id: string; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const mine = ++seq.current;
      const params = new URLSearchParams({ programId, limit: "30" });
      if (status) params.set("status", status);
      if (flagged) params.set("flagged", "true");
      if (after) params.set("cursor", after);
      const res = await requestJson<{ items: EventItem[]; nextCursor: string | null }>(`${ENGAGEMENT_API}/referral/events?${params}`);
      if (mine !== seq.current) return;
      if (res.ok) {
        setEvents((prev) => (after && prev ? [...prev, ...res.data.items] : res.data.items));
        setCursor(res.data.nextCursor);
        setError(null);
      } else setError(res.error);
    },
    [programId, status, flagged]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    void load(null);
  }, [load]);

  async function review(id: string, decision: "APPROVE" | "REJECT", reason?: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await requestJson(`${ENGAGEMENT_API}/referral/events/${id}`, jsonInit("PATCH", { decision, reason: reason?.trim() || undefined }));
      if (res.ok) {
        setReject(null);
        void load(null);
      } else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel space-y-3 rounded-xl p-4" aria-label="Takliflar">
      <h2 className="text-sm font-semibold text-foreground">Takliflar</h2>
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputClass} !w-auto`} value={status} onChange={(e) => setStatus(e.target.value as EventItem["status"] | "")} aria-label="Holat">
          <option value="">Barcha holatlar</option>
          {(Object.keys(EVENT_STATUS) as EventItem["status"][]).map((s) => (
            <option key={s} value={s}>
              {EVENT_STATUS[s].label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Faqat shubhalilar
        </label>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {events === null ? (
        <p className="py-4 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : events.length === 0 ? (
        <EmptyState title="Taklif yo'q" body="Havola orqali kelgan do'stlar shu yerda ko'rinadi." />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {events.map((e) => {
            const st = EVENT_STATUS[e.status];
            const open = e.fraudFlags.length > 0 && (e.status === "PENDING" || e.status === "QUALIFIED");
            return (
              <li key={e.id} className="space-y-2 px-3 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-foreground">
                    <b>{e.referrerUsername ? `@${e.referrerUsername}` : e.referrerIgUserId}</b> → {e.refereeUsername ? `@${e.refereeUsername}` : e.refereeIgUserId}
                  </span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                  <span className="ml-auto text-xs text-muted">{formatDateTime(e.createdAt)}</span>
                </div>
                {e.fraudFlags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {e.fraudFlags.map((f) => (
                      <Pill key={f} tone="error">
                        {fraudLabels[f] ?? f}
                      </Pill>
                    ))}
                  </div>
                )}
                {e.rejectReason && <p className="text-xs text-muted">Sabab: {e.rejectReason}</p>}
                {canManage && open && (reject?.id === e.id ? (
                  <div className="space-y-2 rounded-lg border border-border p-3">
                    <label className="block text-xs font-semibold text-muted" htmlFor={`rej-${e.id}`}>
                      Rad etish sababi (ixtiyoriy)
                    </label>
                    <input id={`rej-${e.id}`} className={inputClass} value={reject.reason} maxLength={300} onChange={(ev) => setReject({ id: e.id, reason: ev.target.value })} />
                    <div className="flex gap-2">
                      <button type="button" className={primaryButton} disabled={busy === e.id} onClick={() => void review(e.id, "REJECT", reject.reason)}>
                        Rad etish
                      </button>
                      <button type="button" className={secondaryButton} onClick={() => setReject(null)}>
                        Bekor
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={secondaryButton} disabled={busy === e.id} onClick={() => void review(e.id, "APPROVE")}>
                      Tasdiqlash va mukofotlash
                    </button>
                    <button type="button" className={secondaryButton} onClick={() => setReject({ id: e.id, reason: "" })}>
                      Rad etish…
                    </button>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <button type="button" className={secondaryButton} onClick={() => void load(cursor)}>
          Yana yuklash
        </button>
      )}
    </section>
  );
}
