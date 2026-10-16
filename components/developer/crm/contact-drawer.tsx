"use client";

/**
 * Contact detail (TZ 27, 32): fields and custom fields, tags editor, status,
 * assign / take / release, a note, and the merged timeline (comment → reply
 * → DM → AI reply → lead → delivery → CRM events) with "Eskilarini yuklash".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Field, formatDateTime, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { TemperatureBadge } from "./contacts-tab";
import {
  ACTOR_TEXT,
  contactLabel,
  CRM_API,
  formatRelative,
  jsonInit,
  requestJson,
  STATUS_TEXT,
  TIMELINE_ICON,
  windowState,
  type ContactDetail,
  type ContactStatus,
  type Meta,
  type TimelineItem,
  type TimelinePage,
} from "./shared";
import { TagChip } from "./tags-tab";

const STATUSES = Object.keys(STATUS_TEXT) as ContactStatus[];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 break-words text-right text-foreground">{children}</span>
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const icon = TIMELINE_ICON[item.type] ?? "•";
  const customer = item.actorKind === "CUSTOMER";
  return (
    <li className={`flex gap-2 ${customer ? "" : ""}`}>
      <span className="w-5 shrink-0 text-center" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="font-medium text-foreground">{item.title}</span>
          <span>{ACTOR_TEXT[item.actorKind] ?? item.actorKind}</span>
          <span title={item.occurredAt}>{formatDateTime(item.occurredAt)}</span>
        </div>
        {item.body && <p className={`mt-0.5 whitespace-pre-wrap break-words text-sm ${customer ? "text-foreground" : "text-muted"}`}>{item.body}</p>}
      </div>
    </li>
  );
}

export default function ContactDrawer({
  id,
  meta,
  onClose,
  onChanged,
  onOpenDeal,
}: {
  id: string;
  meta: Meta;
  onClose: () => void;
  onChanged: () => void;
  onOpenDeal: () => void;
}) {
  const [data, setData] = useState<ContactDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelinePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [tagToAdd, setTagToAdd] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customValue, setCustomValue] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<ContactDetail>(`${CRM_API}/contacts/${id}`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setData(res.data);
      setTimeline(res.data.timeline);
    } else setError(res.error);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per contact
    setData(null);
    setTimeline(null);
    void load();
  }, [load]);

  async function act(path: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${CRM_API}/contacts/${id}${path}`, init);
      if (!res.ok) setError(res.error);
      return res.ok;
    } finally {
      setBusy(false);
      void load();
      onChanged();
    }
  }

  async function loadOlder() {
    if (!timeline?.nextBefore) return;
    setLoadingOlder(true);
    const res = await requestJson<TimelinePage>(`${CRM_API}/contacts/${id}/timeline?before=${encodeURIComponent(timeline.nextBefore)}&limit=50`);
    setLoadingOlder(false);
    if (res.ok) setTimeline({ ...res.data, items: [...timeline.items, ...res.data.items] });
    else setError(res.error);
  }

  const canWrite = meta.me.permissions.includes("assign_leads");
  const isManager = meta.me.canManage;
  const contact = data?.contact ?? null;
  const win = windowState(contact?.lastInboundAt);
  const mine = Boolean(contact && meta.me.memberId && contact.assignedMemberId === meta.me.memberId);
  const assignable = meta.members.filter((m) => m.normalizedRole !== "VIEWER");
  const availableTags = meta.tags.filter((t) => !data?.tags.some((x) => x.id === t.id));
  const custom = contact?.customFields && typeof contact.customFields === "object" ? Object.entries(contact.customFields) : [];

  return (
    <aside className="panel flex max-h-[85vh] flex-col rounded-xl" aria-label="Kontakt tafsilotlari">
      <div className="flex items-start justify-between gap-2 border-b border-border p-4">
        <div className="min-w-0">
          <p className="truncate font-semibold text-foreground">{contact ? contactLabel(contact) : "Kontakt"}</p>
          {contact && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              {data?.accountUsername && <span>@{data.accountUsername}</span>}
              <TemperatureBadge temperature={contact.temperature} score={contact.score} hasAiState={contact.hasAiState} />
              <Pill tone={STATUS_TEXT[contact.status]?.tone ?? "muted"}>{STATUS_TEXT[contact.status]?.label ?? contact.status}</Pill>
              {win.open ? <Pill tone="success">24h oyna: {win.closesIn}</Pill> : <Pill tone="muted">24h oyna yopiq</Pill>}
            </div>
          )}
        </div>
        <button type="button" className={secondaryButton} onClick={onClose} aria-label="Yopish">
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {error && <Notice tone="error">{error}</Notice>}
        {!data || !contact ? (
          !error && <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : (
          <>
            <section className="space-y-1.5">
              <Row label="Ism">{contact.name ?? "—"}</Row>
              <Row label="Telefon">{contact.phoneE164 ?? "—"}</Row>
              <Row label="Email">{contact.email ?? "—"}</Row>
              <Row label="Til">{contact.language ?? "—"}</Row>
              <Row label="Manba">{meta.labels.source[contact.source] ?? contact.source}</Row>
              <Row label="Oxirgi xabari">{formatRelative(contact.lastInboundAt)}</Row>
              <Row label="Oxirgi aloqa">{formatRelative(contact.lastInteractionAt)}</Row>
              <Row label="Aloqalar soni">{contact.interactionCount}</Row>
              <Row label="Operator">{data.assignedMember ? data.assignedMember.name || data.assignedMember.email || "—" : "—"}</Row>
              {contact.optedOutAt && (
                <Row label="Obuna">
                  <span className="text-warning">Chiqqan ({contact.optOutReason === "stop_word" ? "STOP yozgan" : "qo'lda"})</span>
                </Row>
              )}
              {contact.deals.length > 0 && (
                <Row label="Bitim">
                  <button type="button" className="text-accent hover:underline" onClick={onOpenDeal}>
                    {contact.deals[0].stage.name}
                    {contact.deals[0].wonAt ? " · yutildi" : contact.deals[0].lostAt ? " · yo'qotildi" : ""}
                  </button>
                </Row>
              )}
            </section>

            {canWrite && (
              <section className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-xs font-semibold text-foreground">Holat va operator</p>
                <div className="flex flex-wrap gap-2">
                  <label className="sr-only" htmlFor="crm-status">
                    Holat
                  </label>
                  <select
                    id="crm-status"
                    className={`${inputClass} w-auto`}
                    value={contact.status}
                    disabled={busy}
                    onChange={(e) => void act("", jsonInit("PATCH", { status: e.target.value }))}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_TEXT[s].label}
                      </option>
                    ))}
                  </select>
                  {!mine && meta.me.memberId && (
                    <button type="button" className={primaryButton} disabled={busy} onClick={() => void act("/take", { method: "POST" })}>
                      Qabul qildim
                    </button>
                  )}
                  {contact.assignedMemberId && (mine || isManager) && (
                    <ConfirmButton label="Bo'shatish" question="Operator bo'shatilsinmi?" confirmLabel="Bo'shatish" busy={busy} onConfirm={() => void act("/release", { method: "POST" })} />
                  )}
                </div>
                {isManager && (
                  <div className="flex flex-wrap gap-2">
                    <label className="sr-only" htmlFor="crm-assign">
                      Operator tanlash
                    </label>
                    <select id="crm-assign" className={`${inputClass} w-auto min-w-[12rem]`} value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                      <option value="">Operator tanlang…</option>
                      {assignable.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.email} · {m.roleLabel}
                          {m.telegramLinked ? " · TG" : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={busy || !assignTo}
                      onClick={() => {
                        void act("/assign", jsonInit("POST", { memberId: assignTo }));
                        setAssignTo("");
                      }}
                    >
                      Biriktirish
                    </button>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted">Broadcast obunasi:</span>
                  {contact.optedOutAt ? (
                    <button type="button" className={secondaryButton} disabled={busy} onClick={() => void act("", jsonInit("PATCH", { optedOut: false }))}>
                      Obunaga qaytarish
                    </button>
                  ) : (
                    <ConfirmButton label="Obunadan chiqarish" question="Bu odamga endi broadcast yuborilmaydi. Davom etilsinmi?" confirmLabel="Ha" busy={busy} onConfirm={() => void act("", jsonInit("PATCH", { optedOut: true }))} />
                  )}
                </div>
              </section>
            )}

            <section className="space-y-2">
              <p className="text-xs font-semibold text-foreground">Taglar</p>
              <div className="flex flex-wrap gap-1.5">
                {data.tags.length === 0 && <span className="text-xs text-muted">Teg yo&apos;q</span>}
                {data.tags.map((tag) => (
                  <span key={tag.id} title={`${tag.origin}${tag.sourceRef ? ` · ${tag.sourceRef}` : ""}`}>
                    <TagChip tag={tag} onRemove={canWrite ? () => void act(`/tags/${tag.id}`, { method: "DELETE" }) : undefined} />
                  </span>
                ))}
              </div>
              {canWrite && availableTags.length > 0 && (
                <div className="flex gap-2">
                  <label className="sr-only" htmlFor="crm-add-tag">
                    Teg qo&apos;shish
                  </label>
                  <select id="crm-add-tag" className={`${inputClass} w-auto flex-1`} value={tagToAdd} onChange={(e) => setTagToAdd(e.target.value)}>
                    <option value="">Teg tanlang…</option>
                    {availableTags.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy || !tagToAdd}
                    onClick={() => {
                      void act("/tags", jsonInit("POST", { tagId: tagToAdd }));
                      setTagToAdd("");
                    }}
                  >
                    Qo&apos;shish
                  </button>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <p className="text-xs font-semibold text-foreground">Maxsus maydonlar</p>
              {custom.length === 0 ? (
                <p className="text-xs text-muted">Yo&apos;q. Segmentlarda <code>custom.&lt;kalit&gt;</code> sifatida ishlatiladi.</p>
              ) : (
                <ul className="space-y-1">
                  {custom.map(([key, value]) => (
                    <li key={key} className="flex items-center justify-between gap-2 text-sm">
                      <span className="label-mono text-[11px] text-muted">{key}</span>
                      <span className="min-w-0 flex-1 truncate text-right text-foreground">{String(value)}</span>
                      {canWrite && (
                        <button type="button" className="text-xs text-muted hover:text-error" aria-label={`${key} maydonini o'chirish`} onClick={() => void act("", jsonInit("PATCH", { customFields: { [key]: null } }))}>
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canWrite && (
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input className={inputClass} placeholder="kalit (city)" value={customKey} aria-label="Maydon nomi" onChange={(e) => setCustomKey(e.target.value)} />
                  <input className={inputClass} placeholder="qiymat" value={customValue} aria-label="Maydon qiymati" onChange={(e) => setCustomValue(e.target.value)} />
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy || !customKey.trim() || !customValue.trim()}
                    onClick={() => {
                      const raw = customValue.trim();
                      const value = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
                      void act("", jsonInit("PATCH", { customFields: { [customKey.trim()]: value } }));
                      setCustomKey("");
                      setCustomValue("");
                    }}
                  >
                    Saqlash
                  </button>
                </div>
              )}
            </section>

            {canWrite && (
              <section className="space-y-2">
                <Field label="Eslatma">
                  <textarea className={`${inputClass} min-h-[4rem]`} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Operator uchun izoh…" />
                </Field>
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy || !note.trim()}
                  onClick={async () => {
                    if (await act("/note", jsonInit("POST", { body: note.trim() }))) setNote("");
                  }}
                >
                  Eslatma qo&apos;shish
                </button>
              </section>
            )}

            <section className="space-y-2">
              <p className="text-xs font-semibold text-foreground">Timeline</p>
              {timeline && timeline.items.length === 0 ? (
                <p className="text-xs text-muted">Hali hodisa yo&apos;q.</p>
              ) : (
                <ul className="space-y-3">{timeline?.items.map((item) => <TimelineRow key={`${item.sourceTable}:${item.sourceId}`} item={item} />)}</ul>
              )}
              {timeline?.hasMore && (
                <button type="button" className={secondaryButton} disabled={loadingOlder} onClick={() => void loadOlder()}>
                  {loadingOlder ? "Yuklanmoqda…" : "Eskilarini yuklash"}
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
