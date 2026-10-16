"use client";

/**
 * Kontaktlar (TZ 27): search, segment picker, quick filter chips, the table
 * (temperature / score / tags / operator / last interaction), CSV export and
 * the detail drawer. The list is keyset-paged ("Yana yuklash").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, inputClass, Pill, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import ContactDrawer from "./contact-drawer";
import type { Navigate } from "./crm-dashboard";
import {
  contactLabel,
  CRM_API,
  formatRelative,
  requestJson,
  STATUS_TEXT,
  TEMPERATURE_TEXT,
  windowState,
  type ContactPage,
  type ContactRow,
  type Meta,
  type SegmentFilter,
} from "./shared";
import { TagChip } from "./tags-tab";

type Chip = { key: string; label: string; filter: SegmentFilter };

const CHIPS: Chip[] = [
  { key: "hot", label: "🔥 Hot", filter: { v: 1, all: [{ field: "temperature", op: "eq", value: "HOT" }] } },
  { key: "phone", label: "Telefon bor", filter: { v: 1, all: [{ field: "phone_present", op: "is_true" }] } },
  { key: "unassigned", label: "Operatorsiz", filter: { v: 1, all: [{ field: "assigned", op: "is_false" }] } },
  { key: "window", label: "24h oyna ochiq", filter: { v: 1, all: [{ field: "window_open", op: "is_true" }] } },
  { key: "today", label: "Bugun faol", filter: { v: 1, all: [{ field: "last_interaction", op: "within_days", value: 1 }] } },
  { key: "new", label: "Yangi", filter: { v: 1, all: [{ field: "status", op: "eq", value: "NEW" }] } },
];

export function TemperatureBadge({ temperature, score, hasAiState }: { temperature: string; score: number; hasAiState: boolean }) {
  if (!hasAiState) return <span className="text-xs text-muted">—</span>;
  const t = TEMPERATURE_TEXT[temperature as keyof typeof TEMPERATURE_TEXT];
  if (!t) return <span className="text-xs text-muted">{temperature}</span>;
  return (
    <Pill tone={t.tone}>
      {t.emoji} {t.label} {score}
    </Pill>
  );
}

export default function ContactsTab({
  meta,
  navigate,
  contactId,
  segmentId,
  onMetaChanged,
}: {
  meta: Meta;
  navigate: Navigate;
  contactId: string | null;
  segmentId: string | null;
  onMetaChanged: () => void;
}) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [chip, setChip] = useState<string | null>(null);
  const [page, setPage] = useState<ContactPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const query = useCallback(
    (cursor?: string | null) => {
      const params = new URLSearchParams();
      if (debouncedQ) params.set("q", debouncedQ);
      if (segmentId) params.set("segmentId", segmentId);
      else if (chip) {
        const found = CHIPS.find((c) => c.key === chip);
        if (found) params.set("filter", JSON.stringify(found.filter));
      }
      if (cursor) params.set("cursor", cursor);
      params.set("limit", "50");
      return params;
    },
    [debouncedQ, segmentId, chip]
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<ContactPage>(`${CRM_API}/contacts?${query().toString()}`);
    if (mine !== seq.current) return;
    if (res.ok) setPage(res.data);
    else setError(res.error);
  }, [query]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per filter change
    void load();
  }, [load]);

  async function loadMore() {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    const mine = seq.current;
    const res = await requestJson<ContactPage>(`${CRM_API}/contacts?${query(page.nextCursor).toString()}`);
    setLoadingMore(false);
    if (mine !== seq.current) return;
    if (res.ok) setPage({ ...res.data, items: [...page.items, ...res.data.items] });
    else setError(res.error);
  }

  const memberName = (id: string | null) => {
    if (!id) return null;
    const m = meta.members.find((x) => x.id === id);
    return m ? m.name || m.email || "—" : "—";
  };

  const exportHref = `${CRM_API}/export.csv?${query().toString()}`;
  const canExport = meta.me.permissions.includes("export_data");
  const activeSegment = segmentId ? meta.segments.find((s) => s.id === segmentId) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="sr-only" htmlFor="crm-search">
          Qidirish
        </label>
        <input
          id="crm-search"
          className={`${inputClass} sm:max-w-xs`}
          placeholder="@username, ism yoki telefon…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="sr-only" htmlFor="crm-segment">
          Segment
        </label>
        <select
          id="crm-segment"
          className={`${inputClass} sm:w-auto sm:min-w-[12rem]`}
          value={segmentId ?? ""}
          onChange={(e) => {
            setChip(null);
            navigate({ segment: e.target.value || null });
          }}
        >
          <option value="">Barcha kontaktlar</option>
          {meta.segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.lastCount !== null ? ` (${s.lastCount})` : ""}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        {canExport ? (
          <a href={exportHref} className={secondaryButton} download>
            CSV eksport{page ? ` (${page.total})` : ""}
          </a>
        ) : (
          <span className="text-xs text-muted">Eksport: menejer / admin</span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tez filtrlar">
        {CHIPS.map((c) => {
          const on = chip === c.key && !segmentId;
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={on}
              onClick={() => {
                if (segmentId) navigate({ segment: null });
                setChip(on ? null : c.key);
              }}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
              }`}
            >
              {c.label}
            </button>
          );
        })}
        {activeSegment && (
          <span className="rounded-full border border-accent bg-accent/10 px-3 py-1 text-xs font-medium text-foreground">
            Segment: {activeSegment.name}
          </span>
        )}
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span>{error}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      <div className={`grid gap-4 ${contactId ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]" : ""}`}>
        <section className="panel min-w-0 overflow-hidden rounded-xl">
          {page === null ? (
            !error && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
          ) : page.items.length === 0 ? (
            <EmptyState
              title="Kontakt topilmadi"
              body={meta.me.canManage ? "Hali ma'lumot bo'lmasa, \"Umumiy\" tabida Backfill'ni ishga tushiring." : "Filtrni o'zgartirib ko'ring."}
            />
          ) : (
            <>
              <p className="border-b border-border px-4 py-2 text-xs text-muted">
                {page.total} ta kontakt · {page.items.length} ko&apos;rsatilmoqda
              </p>
              <ul className="divide-y divide-border">
                {page.items.map((c) => (
                  <ContactRowItem key={c.id} contact={c} active={c.id === contactId} memberName={memberName(c.assignedMemberId)} onOpen={() => navigate({ contact: c.id })} />
                ))}
              </ul>
              {page.nextCursor && (
                <div className="border-t border-border p-3 text-center">
                  <button type="button" className={secondaryButton} disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? "Yuklanmoqda…" : "Yana yuklash"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {contactId && (
          <ContactDrawer
            id={contactId}
            meta={meta}
            onClose={() => navigate({ contact: null })}
            onChanged={() => {
              void load();
              onMetaChanged();
            }}
            onOpenDeal={() => navigate({ tab: "pipeline" })}
          />
        )}
      </div>

      {!meta.me.permissions.includes("view_contacts") && <Notice tone="error">Kontaktlarni ko&apos;rish ruxsati yo&apos;q.</Notice>}
    </div>
  );
}

function ContactRowItem({ contact, active, memberName, onOpen }: { contact: ContactRow; active: boolean; memberName: string | null; onOpen: () => void }) {
  const status = STATUS_TEXT[contact.status];
  const win = windowState(contact.lastInboundAt);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={`flex w-full flex-col gap-1.5 px-4 py-3 text-left hover:bg-surface-hover/50 ${active ? "bg-accent/5" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{contactLabel(contact)}</span>
          {contact.name && contact.username && <span className="text-xs text-muted">{contact.name}</span>}
          <TemperatureBadge temperature={contact.temperature} score={contact.score} hasAiState={contact.hasAiState} />
          {status && <Pill tone={status.tone}>{status.label}</Pill>}
          {contact.optedOutAt && <Pill tone="muted">🔕 Obunadan chiqqan</Pill>}
          {win.open && <span className="label-mono text-[10px] text-success">24h: {win.closesIn}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>{contact.phoneE164 ?? "telefon yo'q"}</span>
          <span>·</span>
          <span>{memberName ? `👤 ${memberName}` : "operatorsiz"}</span>
          <span>·</span>
          <span title={contact.lastInteractionAt ?? ""}>{formatRelative(contact.lastInteractionAt)}</span>
          {contact.deals[0] && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: contact.deals[0].stage.color ?? "#888" }} aria-hidden="true" />
                {contact.deals[0].stage.name}
              </span>
            </>
          )}
        </div>
        {contact.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {contact.tags.slice(0, 6).map((link) => (
              <TagChip key={link.id} tag={link.tag} />
            ))}
            {contact.tags.length > 6 && <span className="text-xs text-muted">+{contact.tags.length - 6}</span>}
          </div>
        )}
      </button>
    </li>
  );
}
