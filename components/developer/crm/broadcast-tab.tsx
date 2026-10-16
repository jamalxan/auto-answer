"use client";

/**
 * Broadcast (TZ 33): the list, the builder (account, audience = segment or
 * inline filter, message with preview, quick replies, schedule, throttle /
 * caps) with the policy-aware audience preview (per-reason counts and the
 * Meta 24-hour explanation), and the detail (counters, recipients by status /
 * reason, pause / resume / cancel).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChipInput, EmptyState, Field, formatDateTime, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Advanced, CharCount, ConfirmButton, Notice } from "@/components/developer/comments/parts";
import type { Navigate } from "./crm-dashboard";
import { SegmentBuilder } from "./segments-tab";
import {
  BROADCAST_STATUS_TEXT,
  CRM_API,
  fromLocalInput,
  jsonInit,
  RECIPIENT_STATUS_TEXT,
  requestJson,
  type AudiencePreview,
  type BroadcastView,
  type Meta,
  type RecipientsPage,
  type RecipientStatus,
  type SegmentFilter,
} from "./shared";

const MESSAGE_MAX = 1000;
const EMPTY_FILTER: SegmentFilter = { v: 1, all: [] };

function AudiencePanel({ preview, loading, error }: { preview: AudiencePreview | null; loading: boolean; error: string | null }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-hover/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground">
          {preview ? (
            <>
              Auditoriya: <b>{preview.total}</b> · hozir yuboriladi: <b className="text-success">{preview.eligibleNow}</b>
              {preview.evaluated < preview.total ? <span className="text-muted"> (birinchi {preview.evaluated} tasi tekshirildi)</span> : null}
            </>
          ) : loading ? (
            <span className="text-muted">Hisoblanmoqda…</span>
          ) : (
            <span className="text-muted">Auditoriya</span>
          )}
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {preview && preview.byReason.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {preview.byReason.map((r) => (
            <li key={r.reason} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">
              {r.label}: <b className="text-foreground">{r.count}</b>
            </li>
          ))}
        </ul>
      )}
      {preview && preview.sample.length > 0 && (
        <ul className="divide-y divide-border">
          {preview.sample.map((s) => (
            <li key={s.contactId} className="flex flex-wrap items-center justify-between gap-2 py-1 text-xs">
              <span className="text-foreground">{s.username ? `@${s.username}` : s.name || s.contactId}</span>
              {s.eligible ? (
                <span className="text-success">yuboriladi{s.windowClosesAt ? ` · oyna ${formatDateTime(s.windowClosesAt)} gacha` : ""}</span>
              ) : (
                <span className="text-muted">{s.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Notice tone="info">
        Meta qoidasi: biznes odamga faqat uning oxirgi xabari yoki tugma bosganidan keyingi <b>24 soat</b> ichida yoza oladi. Oynasi yopiqlar,
        obunadan chiqqanlar, yaqinda broadcast olganlar va operator bilan suhbatdagilar <b>sababi bilan</b> o&apos;tkazib yuboriladi — hech kim
        majburan yuborilmaydi. Yuborish paytida shartlar qayta tekshiriladi.
      </Notice>
    </div>
  );
}

function Builder({ meta, onCreated, onCancel }: { meta: Meta; onCreated: (id: string) => void; onCancel: () => void }) {
  const d = meta.broadcastDefaults;
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState(meta.accounts.find((a) => a.tokenStatus === "ACTIVE")?.id ?? meta.accounts[0]?.id ?? "");
  const [audience, setAudience] = useState<"segment" | "filter">(meta.segments.length > 0 ? "segment" : "filter");
  const [segmentId, setSegmentId] = useState(meta.segments[0]?.id ?? "");
  const [filter, setFilter] = useState<SegmentFilter>(EMPTY_FILTER);
  const [message, setMessage] = useState("");
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [throttle, setThrottle] = useState(d.throttlePerHour);
  const [capHours, setCapHours] = useState(d.frequencyCapHours);
  const [replyHours, setReplyHours] = useState(d.replyWindowHours);
  const [convDays, setConvDays] = useState(d.conversionWindowDays);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const audienceBody = JSON.stringify({
    instagramAccountId: accountId,
    segmentId: audience === "segment" ? segmentId || null : null,
    audienceFilter: audience === "filter" ? filter : null,
    frequencyCapHours: capHours,
  });

  useEffect(() => {
    if (!accountId) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      const res = await requestJson<AudiencePreview>(`${CRM_API}/broadcasts/preview`, jsonInit("POST", JSON.parse(audienceBody)));
      if (mine !== seq.current) return;
      setPreviewLoading(false);
      if (res.ok) {
        setPreview(res.data);
        setPreviewError(null);
      } else setPreviewError(res.error);
    }, 500);
    return () => clearTimeout(timer);
  }, [audienceBody, accountId]);

  const sample = meta.accounts[0] ? "Ali" : "Ali";
  const rendered = message.replace(/\{(ism|name)\}/gi, sample);

  async function save(schedule: boolean) {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name,
        instagramAccountId: accountId,
        segmentId: audience === "segment" ? segmentId || null : null,
        audienceFilter: audience === "filter" ? filter : null,
        message,
        quickReplies,
        scheduledAt: fromLocalInput(scheduledAt),
        throttlePerHour: throttle,
        frequencyCapHours: capHours,
        replyWindowHours: replyHours,
        conversionWindowDays: convDays,
      };
      const created = await requestJson<BroadcastView>(`${CRM_API}/broadcasts`, jsonInit("POST", body));
      if (!created.ok) {
        setError(created.error);
        return;
      }
      if (schedule) {
        const scheduled = await requestJson<BroadcastView>(`${CRM_API}/broadcasts/${created.data.id}/schedule`, jsonInit("POST", { scheduledAt: fromLocalInput(scheduledAt) }));
        if (!scheduled.ok) {
          setError(`Qoralama saqlandi, lekin rejalashtirilmadi: ${scheduled.error}`);
          onCreated(created.data.id);
          return;
        }
      }
      onCreated(created.data.id);
    } finally {
      setBusy(false);
    }
  }

  const valid = name.trim() && accountId && message.trim() && message.length <= MESSAGE_MAX && (audience === "filter" || segmentId);

  return (
    <div className="space-y-4 rounded-lg border border-dashed border-border p-3 sm:p-4">
      <p className="text-sm font-semibold text-foreground">Yangi broadcast</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nomi">
          <input className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Oktabr aksiyasi" />
        </Field>
        <Field label="Instagram akkaunt" hint="Auditoriya shu akkauntning kontaktlari">
          <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {meta.accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={a.tokenStatus !== "ACTIVE"}>
                @{a.username}
                {a.tokenStatus !== "ACTIVE" ? " · ulanish uzilgan" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Auditoriya">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Auditoriya turi">
          <button type="button" role="radio" aria-checked={audience === "segment"} className={audience === "segment" ? primaryButton : secondaryButton} onClick={() => setAudience("segment")}>
            Saqlangan segment
          </button>
          <button type="button" role="radio" aria-checked={audience === "filter"} className={audience === "filter" ? primaryButton : secondaryButton} onClick={() => setAudience("filter")}>
            Shu yerda filtr
          </button>
        </div>
      </Field>
      {audience === "segment" ? (
        meta.segments.length === 0 ? (
          <Notice tone="warning">Segment yo&apos;q — &quot;Segmentlar&quot; tabida yarating yoki filtrni shu yerda tuzing.</Notice>
        ) : (
          <select className={inputClass} value={segmentId} aria-label="Segment" onChange={(e) => setSegmentId(e.target.value)}>
            {meta.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.lastCount !== null ? ` (${s.lastCount})` : ""}
              </option>
            ))}
          </select>
        )
      ) : (
        <SegmentBuilder meta={meta} value={filter} onChange={setFilter} />
      )}

      <AudiencePanel preview={preview} loading={previewLoading} error={previewError} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Field label="Xabar" hint="{ism} — mijoz ismi (yo'q bo'lsa @username).">
          <textarea className={`${inputClass} min-h-[8rem]`} value={message} maxLength={MESSAGE_MAX + 50} onChange={(e) => setMessage(e.target.value)} placeholder="Salom {ism}! Bugun …" />
          <CharCount value={message} max={MESSAGE_MAX} />
        </Field>
        <Field label="Ko'rinishi">
          <div className="rounded-xl border border-border bg-surface p-3">
            <div className="max-w-[18rem] whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-accent/15 px-3 py-2 text-sm text-foreground">
              {rendered || <span className="text-muted">Xabar matni…</span>}
            </div>
            {quickReplies.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {quickReplies.map((q) => (
                  <span key={q} className="rounded-full border border-accent/40 px-3 py-1 text-xs text-foreground">
                    {q}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Field>
      </div>

      <Field label="Tezkor javob tugmalari (ixtiyoriy)" hint="Ko'pi bilan 13 ta, har biri 20 belgigacha. Bosilganda mijozning xabari sifatida keladi (24 soatlik oynani yangilaydi).">
        <ChipInput values={quickReplies} onChange={(v) => setQuickReplies(v.map((x) => x.slice(0, 20)))} max={13} placeholder="Ha, qiziq, Narxi?" />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Yuborish vaqti" hint="Bo'sh = darhol">
          <input type="datetime-local" className={inputClass} value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </Field>
        <Field label="Soatiga nechta" hint="1–500; har 5 daqiqada bir partiya. Akkauntning 750/soat limiti baribir amal qiladi.">
          <input type="number" min={1} max={500} className={inputClass} value={throttle} onChange={(e) => setThrottle(Math.min(500, Math.max(1, Number(e.target.value) || 1)))} />
        </Field>
      </div>
      <Advanced>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Chastota chegarasi (soat)" hint="Bir odamga shuncha soatda bittadan ko'p broadcast bormaydi; 0 = chegara yo'q">
            <input type="number" min={0} max={720} className={inputClass} value={capHours} onChange={(e) => setCapHours(Math.max(0, Number(e.target.value) || 0))} />
          </Field>
          <Field label="Javob oynasi (soat)" hint="Shu vaqt ichidagi javob broadcast'ga yoziladi">
            <input type="number" min={1} max={336} className={inputClass} value={replyHours} onChange={(e) => setReplyHours(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Field label="Konversiya oynasi (kun)" hint="Shu kunlar ichida bitim yaratilsa / ko'chsa — konversiya">
            <input type="number" min={1} max={90} className={inputClass} value={convDays} onChange={(e) => setConvDays(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
        </div>
      </Advanced>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondaryButton} disabled={busy || !valid} onClick={() => void save(false)}>
          Qoralama saqlash
        </button>
        <ConfirmButton
          label={busy ? "Saqlanmoqda…" : scheduledAt ? "Rejalashtirish" : "Hozir yuborish"}
          question={`${preview?.eligibleNow ?? "?"} kishiga yuboriladi${preview && preview.total > preview.eligibleNow ? `, ${preview.total - preview.eligibleNow} tasi o'tkaziladi` : ""}. Davom etilsinmi?`}
          confirmLabel="Ha"
          busy={busy}
          disabled={!valid}
          onConfirm={() => void save(true)}
        />
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Bekor
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function Detail({ id, meta, onClose, onChanged, navigate }: { id: string; meta: Meta; onClose: () => void; onChanged: () => void; navigate: Navigate }) {
  const [data, setData] = useState<BroadcastView | null>(null);
  const [recipients, setRecipients] = useState<RecipientsPage | null>(null);
  const [status, setStatus] = useState<RecipientStatus | "">("");
  const [reason, setReason] = useState("");
  const [replied, setReplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const params = new URLSearchParams({ limit: "50" });
    if (status) params.set("status", status);
    if (reason) params.set("reason", reason);
    if (replied) params.set("replied", "true");
    const [b, r] = await Promise.all([
      requestJson<BroadcastView>(`${CRM_API}/broadcasts/${id}`),
      requestJson<RecipientsPage>(`${CRM_API}/broadcasts/${id}/recipients?${params.toString()}`),
    ]);
    if (mine !== seq.current) return;
    if (b.ok) setData(b.data);
    else setError(b.error);
    if (r.ok) setRecipients(r.data);
    else setError(r.error);
  }, [id, status, reason, replied]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per broadcast / filter
    void load();
  }, [load]);

  // Live counters while it runs.
  useEffect(() => {
    if (!data || (data.status !== "RUNNING" && data.status !== "SCHEDULED")) return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [data, load]);

  async function act(action: "schedule" | "pause" | "resume" | "cancel") {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${CRM_API}/broadcasts/${id}/${action}`, jsonInit("POST", {}));
      if (!res.ok) setError(res.error);
    } finally {
      setBusy(false);
      void load();
      onChanged();
    }
  }

  async function loadMore() {
    if (!recipients || recipients.nextCursor === null) return;
    setLoadingMore(true);
    const params = new URLSearchParams({ limit: "50", cursor: String(recipients.nextCursor) });
    if (status) params.set("status", status);
    if (reason) params.set("reason", reason);
    if (replied) params.set("replied", "true");
    const res = await requestJson<RecipientsPage>(`${CRM_API}/broadcasts/${id}/recipients?${params.toString()}`);
    setLoadingMore(false);
    if (res.ok) setRecipients({ ...res.data, recipients: [...recipients.recipients, ...res.data.recipients] });
    else setError(res.error);
  }

  const canManage = meta.me.canManage;
  const c = data?.counters;
  const st = data ? BROADCAST_STATUS_TEXT[data.status] : null;

  return (
    <section className="panel space-y-4 rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-foreground">{data?.name ?? "Broadcast"}</h2>
            {st && <Pill tone={st.tone}>{st.label}</Pill>}
          </div>
          {data && (
            <p className="mt-1 text-xs text-muted">
              @{data.accountUsername ?? "?"} · {data.segmentName ? `segment: ${data.segmentName}` : "filtr"} · {data.throttlePerHour}/soat ·
              {data.scheduledAt ? ` reja: ${formatDateTime(data.scheduledAt)}` : ""}
              {data.startedAt ? ` · boshlandi: ${formatDateTime(data.startedAt)}` : ""}
              {data.completedAt ? ` · tugadi: ${formatDateTime(data.completedAt)}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && data?.status === "DRAFT" && (
            <ConfirmButton label="Yuborish" question="Rejalashtirilsinmi?" confirmLabel="Ha" busy={busy} onConfirm={() => void act("schedule")} />
          )}
          {canManage && (data?.status === "RUNNING" || data?.status === "SCHEDULED") && (
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => void act("pause")}>
              To&apos;xtatish
            </button>
          )}
          {canManage && data?.status === "PAUSED" && (
            <button type="button" className={primaryButton} disabled={busy} onClick={() => void act("resume")}>
              Davom ettirish
            </button>
          )}
          {canManage && data && !["COMPLETED", "CANCELLED", "FAILED"].includes(data.status) && (
            <ConfirmButton label="Bekor qilish" question="Qolganlar yuborilmaydi. Bekor qilinsinmi?" confirmLabel="Bekor qilish" danger busy={busy} onConfirm={() => void act("cancel")} />
          )}
          <button type="button" className={secondaryButton} onClick={onClose} aria-label="Yopish">
            ✕
          </button>
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {data?.lastError && <Notice tone="warning">{data.lastError}</Notice>}

      {c && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {[
            ["Jami", c.total, ""],
            ["Yuboriladi", c.eligible, ""],
            ["Navbatda", c.pending, c.pending ? "text-warning" : ""],
            ["Yuborildi", c.sent, c.sent ? "text-success" : ""],
            ["O'tkazildi", c.skipped, ""],
            ["Xato", c.failed, c.failed ? "text-error" : ""],
            ["Javob berdi", c.replied, c.replied ? "text-success" : ""],
            ["Konversiya", c.converted, c.converted ? "text-success" : ""],
          ].map(([label, value, tone]) => (
            <div key={String(label)} className="rounded-lg border border-border px-3 py-2">
              <p className="label-mono text-[10px] text-muted">{label}</p>
              <p className={`text-lg font-bold ${tone || "text-foreground"}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {data && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-muted">Xabar matni</summary>
          <div className="space-y-2 border-t border-border p-3">
            <p className="whitespace-pre-wrap text-sm text-foreground">{data.message}</p>
            {data.quickReplies.length > 0 && <p className="text-xs text-muted">Tugmalar: {data.quickReplies.join(" · ")}</p>}
          </div>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="bc-status">
          Holat bo&apos;yicha
        </label>
        <select id="bc-status" className={`${inputClass} w-auto`} value={status} onChange={(e) => setStatus(e.target.value as RecipientStatus | "")}>
          <option value="">Barcha holatlar</option>
          {(Object.keys(RECIPIENT_STATUS_TEXT) as RecipientStatus[]).map((s) => (
            <option key={s} value={s}>
              {RECIPIENT_STATUS_TEXT[s].label}
              {recipients ? ` (${recipients.byStatus[s]})` : ""}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="bc-reason">
          Sabab bo&apos;yicha
        </label>
        <select id="bc-reason" className={`${inputClass} w-auto`} value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Barcha sabablar</option>
          {recipients?.byReason.map((r) => (
            <option key={r.reason} value={r.reason}>
              {r.label} ({r.count})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={replied} onChange={(e) => setReplied(e.target.checked)} />
          faqat javob berganlar
        </label>
      </div>

      {!recipients ? (
        <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : recipients.recipients.length === 0 ? (
        <EmptyState title="Qabul qiluvchi yo'q" body={data?.status === "DRAFT" || data?.status === "SCHEDULED" ? "Ro'yxat boshlanganda tuziladi." : "Filtrga mos yozuv yo'q."} />
      ) : (
        <ul className="divide-y divide-border">
          {recipients.recipients.map((r) => {
            const s = RECIPIENT_STATUS_TEXT[r.status];
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <button type="button" className="font-medium text-foreground hover:text-accent" onClick={() => navigate({ tab: "contacts", contact: r.contactId })}>
                    {r.username ? `@${r.username}` : r.name || r.contactId}
                  </button>
                  <Pill tone={s.tone}>{s.label}</Pill>
                  {r.reasonLabel && <span className="text-xs text-muted">{r.reasonLabel}</span>}
                  {r.error && !r.reasonLabel && <span className="text-xs text-error">{r.error}</span>}
                  {r.repliedAt && <Pill tone="success">javob {formatDateTime(r.repliedAt)}</Pill>}
                  {r.convertedAt && <Pill tone="success">konversiya</Pill>}
                </div>
                <span className="text-xs text-muted">
                  {r.sentAt ? formatDateTime(r.sentAt) : ""}
                  {r.attempts > 1 ? ` · ${r.attempts} urinish` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {recipients?.nextCursor !== null && recipients && (
        <button type="button" className={secondaryButton} disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Yuklanmoqda…" : "Yana yuklash"}
        </button>
      )}
    </section>
  );
}

export default function BroadcastTab({ meta, navigate, broadcastId }: { meta: Meta; navigate: Navigate; broadcastId: string | null }) {
  const [list, setList] = useState<BroadcastView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<{ broadcasts: BroadcastView[] }>(`${CRM_API}/broadcasts`);
    if (mine !== seq.current) return;
    if (res.ok) setList(res.data.broadcasts);
    else setError(res.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      {meta.accounts.length === 0 && <Notice tone="warning">Instagram akkaunt ulanmagan — broadcast yuborib bo&apos;lmaydi.</Notice>}

      {broadcastId ? (
        <Detail id={broadcastId} meta={meta} navigate={navigate} onClose={() => navigate({ broadcast: null })} onChanged={() => void load()} />
      ) : creating ? (
        <Builder
          meta={meta}
          onCreated={(id) => {
            setCreating(false);
            void load();
            navigate({ broadcast: id });
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      <section className="panel space-y-3 rounded-xl p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Broadcastlar</h2>
            <p className="mt-1 text-xs text-muted">
              Siyosatga mos yuborish: 24 soatlik oyna, obuna, chastota, handoff — har bir odam uchun sababi ko&apos;rinadi. Javob va konversiya
              broadcast&apos;ga yoziladi.
            </p>
          </div>
          {meta.me.canManage && !creating && meta.accounts.length > 0 && (
            <button
              type="button"
              className={primaryButton}
              onClick={() => {
                navigate({ broadcast: null });
                setCreating(true);
              }}
            >
              + Broadcast
            </button>
          )}
        </div>
        {list === null ? (
          <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : list.length === 0 ? (
          <EmptyState title="Hali broadcast yo'q" body="Segment tanlang, xabar yozing — auditoriya va sabablar darhol ko'rinadi." />
        ) : (
          <ul className="divide-y divide-border">
            {list.map((b) => {
              const s = BROADCAST_STATUS_TEXT[b.status];
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => navigate({ broadcast: b.id })}
                    aria-current={b.id === broadcastId ? "true" : undefined}
                    className={`flex w-full flex-wrap items-center justify-between gap-2 px-1 py-2.5 text-left hover:bg-surface-hover/50 ${b.id === broadcastId ? "bg-accent/5" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{b.name}</span>
                        <Pill tone={s.tone}>{s.label}</Pill>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        @{b.accountUsername ?? "?"} · {b.segmentName ?? "filtr"} · {b.scheduledAt ? formatDateTime(b.scheduledAt) : formatDateTime(b.createdAt)}
                      </p>
                    </div>
                    <span className="text-xs tabular-nums text-muted">
                      {b.counters.sent}/{b.counters.eligible} yuborildi · {b.counters.skipped} o&apos;tkazildi · {b.counters.replied} javob · {b.counters.converted} konv.
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
