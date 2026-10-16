"use client";

/**
 * Pipeline (TZ 30): the Kanban (native HTML5 drag-and-drop plus "move to"
 * buttons for touch / keyboard), Won / Lost with an inline reason, and the
 * stage editor (rename, reorder, add, kind, entry flag, colour).
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { EmptyState, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { TemperatureBadge } from "./contacts-tab";
import type { Navigate } from "./crm-dashboard";
import { CRM_API, formatRelative, jsonInit, requestJson, uid, type KanbanBoard, type KanbanDeal, type Meta, type StageKind, type StageRow } from "./shared";

type StageDraft = { key: string; id: string | null; name: string; kind: StageKind; color: string; isEntry: boolean; dealCount: number };

const COLORS = ["#3B82F6", "#06B6D4", "#8B5CF6", "#F97316", "#EAB308", "#22C55E", "#EF4444", "#64748B"];

function DealCard({
  deal,
  stages,
  memberName,
  busy,
  onMove,
  onOpenContact,
}: {
  deal: KanbanDeal;
  stages: StageRow[];
  memberName: string | null;
  busy: boolean;
  onMove: (stageId: string, lostReason?: string | null) => void;
  onOpenContact: () => void;
}) {
  const [askLost, setAskLost] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const c = deal.contact;
  return (
    <li
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", deal.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab space-y-1.5 rounded-lg border border-border bg-surface p-2.5 active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="min-w-0 truncate text-left text-sm font-medium text-foreground hover:text-accent" onClick={onOpenContact}>
          {c.username ? `@${c.username}` : c.name || deal.title}
        </button>
        <TemperatureBadge temperature={c.temperature} score={c.score} hasAiState={c.hasAiState} />
      </div>
      <p className="truncate text-xs text-muted">{deal.title}</p>
      <p className="text-xs text-muted">
        {c.phoneE164 ?? "telefon yo'q"} · {memberName ? `👤 ${memberName}` : "operatorsiz"} · {formatRelative(deal.stageEnteredAt)}
      </p>
      {deal.lostReason && <p className="text-xs text-error">Sabab: {deal.lostReason}</p>}
      {askLost ? (
        <div className="space-y-1.5">
          <input className={inputClass} placeholder="Yo'qotish sababi (ixtiyoriy)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-label="Yo'qotish sababi" />
          <div className="flex gap-1.5">
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => {
                onMove(askLost, reason.trim() || null);
                setAskLost(null);
                setReason("");
              }}
            >
              Yo&apos;qotildi deb belgilash
            </button>
            <button type="button" className={secondaryButton} onClick={() => setAskLost(null)}>
              Bekor
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <label className="sr-only" htmlFor={`mv-${deal.id}`}>
            Bosqichga ko&apos;chirish
          </label>
          <select
            id={`mv-${deal.id}`}
            className={`${inputClass} py-1 text-xs`}
            value={moveTo}
            disabled={busy}
            onChange={(e) => {
              const stage = stages.find((s) => s.id === e.target.value);
              setMoveTo("");
              if (!stage || stage.id === deal.stageId) return;
              if (stage.kind === "LOST") setAskLost(stage.id);
              else onMove(stage.id);
            }}
          >
            <option value="">Ko&apos;chirish…</option>
            {stages
              .filter((s) => s.id !== deal.stageId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  → {s.name}
                </option>
              ))}
          </select>
        </div>
      )}
    </li>
  );
}

function StageEditor({ pipelineId, stages, onDone, onCancel }: { pipelineId: string; stages: StageRow[]; onDone: () => void; onCancel: () => void }) {
  const [drafts, setDrafts] = useState<StageDraft[]>(() =>
    stages.map((s) => ({ key: uid(), id: s.id, name: s.name, kind: s.kind, color: s.color ?? COLORS[0], isEntry: s.isEntry, dealCount: s.dealCount ?? 0 }))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (key: string, patch: Partial<StageDraft>) =>
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : patch.isEntry ? { ...d, isEntry: false } : d)));
  const move = (index: number, dir: -1 | 1) =>
    setDrafts((list) => {
      const next = [...list];
      const j = index + dir;
      if (j < 0 || j >= next.length) return list;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(
        `${CRM_API}/pipelines/${pipelineId}/stages`,
        jsonInit("PUT", { stages: drafts.map((d, i) => ({ id: d.id, name: d.name.trim(), sort: i, kind: d.kind, color: d.color, isEntry: d.isEntry })) })
      );
      if (res.ok) onDone();
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-semibold text-foreground">Bosqichlarni tahrirlash</p>
      <p className="text-xs text-muted">
        Aynan bitta &quot;kirish&quot; bosqichi (yangi lead tushadigan) bo&apos;lsin; Yutildi / Yo&apos;qotildi turidagi bosqichlar bittadan. Bitimi bor
        bosqich o&apos;chirilmaydi — avval ko&apos;chiring.
      </p>
      <ul className="space-y-2">
        {drafts.map((d, i) => (
          <li key={d.key} className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto] sm:items-center">
            <div className="flex gap-1">
              <button type="button" className={secondaryButton} aria-label="Yuqoriga" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className={secondaryButton} aria-label="Pastga" disabled={i === drafts.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
            </div>
            <input className={inputClass} value={d.name} maxLength={40} aria-label="Bosqich nomi" onChange={(e) => update(d.key, { name: e.target.value })} />
            <select className={`${inputClass} w-auto`} value={d.kind} aria-label="Turi" onChange={(e) => update(d.key, { kind: e.target.value as StageKind })}>
              <option value="OPEN">Jarayonda</option>
              <option value="WON">Yutildi</option>
              <option value="LOST">Yo&apos;qotildi</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="radio" name="entry" checked={d.isEntry} onChange={() => update(d.key, { isEntry: true })} />
              kirish
            </label>
            <input type="color" value={d.color} aria-label="Rang" className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent" onChange={(e) => update(d.key, { color: e.target.value })} />
            <button
              type="button"
              className={secondaryButton}
              aria-label="Bosqichni o'chirish"
              disabled={d.dealCount > 0}
              title={d.dealCount > 0 ? `${d.dealCount} ta bitim bor` : undefined}
              onClick={() => setDrafts((list) => list.filter((x) => x.key !== d.key))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondaryButton}
          onClick={() => setDrafts((list) => [...list, { key: uid(), id: null, name: "", kind: "OPEN", color: COLORS[list.length % COLORS.length], isEntry: false, dealCount: 0 }])}
        >
          + Bosqich
        </button>
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void save()}>
          {busy ? "Saqlanmoqda…" : "Saqlash"}
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Bekor
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

export default function PipelineTab({ meta, navigate, onChanged }: { meta: Meta; navigate: Navigate; onChanged: () => void }) {
  const [pipelineId, setPipelineId] = useState<string>(meta.pipelines.find((p) => p.isDefault)?.id ?? meta.pipelines[0]?.id ?? "");
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<KanbanBoard>(`${CRM_API}/deals${pipelineId ? `?pipelineId=${pipelineId}` : ""}`);
    if (mine !== seq.current) return;
    if (res.ok) setBoard(res.data);
    else setError(res.error);
  }, [pipelineId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per pipeline
    void load();
  }, [load]);

  async function move(dealId: string, stageId: string, lostReason: string | null = null) {
    setBusy(true);
    setError(null);
    // Optimistic: the card jumps, the reload confirms.
    setBoard((b) => {
      if (!b) return b;
      let moved: KanbanDeal | null = null;
      const columns = b.columns.map((col) => {
        const deals = col.deals.filter((d) => {
          if (d.id === dealId) {
            moved = d;
            return false;
          }
          return true;
        });
        return { ...col, deals, count: col.count - (col.deals.length - deals.length) };
      });
      if (moved) {
        const target = columns.find((col) => col.stage.id === stageId);
        if (target) {
          target.deals = [{ ...(moved as KanbanDeal), stageId }, ...target.deals];
          target.count += 1;
        }
      }
      return { ...b, columns };
    });
    try {
      const res = await requestJson(`${CRM_API}/deals/${dealId}/move`, jsonInit("POST", { stageId, lostReason }));
      if (!res.ok) setError(res.error);
    } finally {
      setBusy(false);
      void load();
      onChanged();
    }
  }

  function onDrop(e: DragEvent<HTMLElement>, stage: StageRow) {
    e.preventDefault();
    setOver(null);
    const dealId = e.dataTransfer.getData("text/plain");
    if (!dealId) return;
    const current = board?.columns.find((col) => col.deals.some((d) => d.id === dealId));
    if (!current || current.stage.id === stage.id) return;
    if (stage.kind === "LOST") {
      const reason = window.prompt("Yo'qotish sababi (ixtiyoriy):", "") ?? null;
      void move(dealId, stage.id, reason?.trim() || null);
      return;
    }
    void move(dealId, stage.id);
  }

  const canWrite = meta.me.permissions.includes("assign_leads");
  const memberName = (id: string | null) => {
    const m = id ? meta.members.find((x) => x.id === id) : null;
    return m ? m.name || m.email : null;
  };
  const stages = board?.columns.map((c) => c.stage) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {meta.pipelines.length > 1 && (
            <select className={`${inputClass} w-auto`} value={pipelineId} aria-label="Voronka" onChange={(e) => setPipelineId(e.target.value)}>
              {meta.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {board && (
            <p className="text-sm text-muted">
              <b className="text-foreground">{board.pipeline.name}</b> · {board.total} ta bitim
            </p>
          )}
        </div>
        {meta.me.canManage && board && !editing && (
          <button type="button" className={secondaryButton} onClick={() => setEditing(true)}>
            Bosqichlarni tahrirlash
          </button>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {editing && board && (
        <StageEditor
          pipelineId={board.pipeline.id}
          stages={stages.map((s) => ({ ...s, dealCount: board.columns.find((c) => c.stage.id === s.id)?.count ?? 0 }))}
          onDone={() => {
            setEditing(false);
            void load();
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      {!board ? (
        !error && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : board.columns.length === 0 ? (
        <EmptyState title="Bosqichlar yo'q" body="Bosqichlarni tahrirlab, kamida bitta kirish bosqichi qo'shing." />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2">
          <div className="flex min-w-max gap-3">
            {board.columns.map(({ stage, deals, count }) => (
              <section
                key={stage.id}
                aria-label={stage.name}
                onDragOver={(e) => {
                  if (!canWrite) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (over !== stage.id) setOver(stage.id);
                }}
                onDragLeave={() => setOver((o) => (o === stage.id ? null : o))}
                onDrop={(e) => canWrite && onDrop(e, stage)}
                className={`flex w-[17rem] shrink-0 flex-col rounded-xl border bg-surface-hover/30 ${over === stage.id ? "border-accent" : "border-border"}`}
              >
                <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: stage.color ?? "#888" }} aria-hidden="true" />
                    <span className="truncate text-sm font-semibold text-foreground">{stage.name}</span>
                    {stage.isEntry && <Pill tone="muted">kirish</Pill>}
                    {stage.kind !== "OPEN" && <Pill tone={stage.kind === "WON" ? "success" : "error"}>{stage.kind === "WON" ? "yutildi" : "yo'qotildi"}</Pill>}
                  </div>
                  <span className="text-xs tabular-nums text-muted">{count}</span>
                </header>
                <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto p-2">
                  {deals.length === 0 && <li className="py-4 text-center text-xs text-muted">Bo&apos;sh</li>}
                  {deals.map((deal) => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      stages={canWrite ? stages : []}
                      memberName={memberName(deal.contact.assignedMemberId)}
                      busy={busy || !canWrite}
                      onMove={(stageId, lostReason) => void move(deal.id, stageId, lostReason ?? null)}
                      onOpenContact={() => navigate({ tab: "contacts", contact: deal.contactId })}
                    />
                  ))}
                  {count > deals.length && (
                    <li className="py-2 text-center text-xs text-muted">
                      Eng yangi {deals.length} tasi ko&apos;rsatildi — yana {count - deals.length} ta. Qolganlarini &quot;Kontaktlar&quot; tabida bosqich
                      filtri bilan ko&apos;ring.
                    </li>
                  )}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted">
        Yangi lead doim &quot;kirish&quot; bosqichiga tushadi; Telegram&apos;dagi &quot;Bog&apos;lanildi&quot; tugmasi bitimni &quot;Bog&apos;lanildi&quot;ga
        ko&apos;chiradi. Yutildi / Yo&apos;qotildi JavobAI haroratiga (Mijoz / Yo&apos;qotilgan) yoziladi.
      </p>
      {canWrite && (
        <ConfirmButton label="Kanban'ni yangilash" question="Qayta yuklansinmi?" confirmLabel="Ha" onConfirm={() => void load()} />
      )}
    </div>
  );
}
