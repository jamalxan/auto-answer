"use client";

/**
 * "Giveaway" tab: the list with status and counters, the create wizard
 * (?new=1) and the detail screen (?giveaway=<id>). The URL holds the view, so
 * a link opens the right screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Pill, formatDateTime, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import GiveawayDetailView from "./giveaway-detail";
import GiveawayWizard from "./giveaway-wizard";
import { ENGAGEMENT_API, GIVEAWAY_STATUS, requestJson, type GiveawayRow, type GiveawayStatus, type Meta } from "./shared";
import type { EngagementNavigate } from "./engagement-dashboard";

const FILTERS: Array<[GiveawayStatus | "", string]> = [
  ["", "Hammasi"],
  ["ACTIVE", "Faol"],
  ["DRAFT", "Qoralama"],
  ["CLOSED", "Yopilgan"],
  ["DRAWN", "Qur'a"],
  ["ARCHIVED", "Arxiv"],
];

export default function GiveawayTab({
  meta,
  giveawayId,
  creating,
  navigate,
}: {
  meta: Meta;
  giveawayId: string | null;
  creating: boolean;
  navigate: EngagementNavigate;
}) {
  const [rows, setRows] = useState<GiveawayRow[] | null>(null);
  const [filter, setFilter] = useState<GiveawayStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await requestJson<{ giveaways: GiveawayRow[] }>(`${ENGAGEMENT_API}/giveaways${filter ? `?status=${filter}` : ""}`);
      if (mine !== seq.current) return;
      if (res.ok) setRows(res.data.giveaways);
      else setError(res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    if (giveawayId || creating) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load, giveawayId, creating]);

  if (creating) {
    return <GiveawayWizard meta={meta} giveaway={null} onCancel={() => navigate({ giveaway: null, creating: false })} onSaved={(id) => navigate({ giveaway: id, creating: false })} />;
  }
  if (giveawayId) {
    return <GiveawayDetailView meta={meta} giveawayId={giveawayId} onBack={() => navigate({ giveaway: null })} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Holat bo'yicha filtr">
          {FILTERS.map(([key, label]) => (
            <button
              key={key || "all"}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === key ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {meta.me.canManage && (
          <button type="button" className={primaryButton} onClick={() => navigate({ creating: true })}>
            Yangi giveaway
          </button>
        )}
      </div>

      {error && (
        <Notice tone="error">
          {error}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Qayta urinish
          </button>
        </Notice>
      )}

      {rows === null ? (
        <p className="py-8 text-center text-sm text-muted">{loading ? "Yuklanmoqda…" : ""}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title={filter ? "Bu holatda giveaway yo'q" : "Hali giveaway yo'q"}
          body={filter ? undefined : "Postni tanlang, qoidalarni belgilang — izohlar o'zi yig'iladi, g'olib esa adolatli qur'a bilan tanlanadi."}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map((g) => {
            const st = GIVEAWAY_STATUS[g.status];
            return (
              <li key={g.id}>
                <button type="button" onClick={() => navigate({ giveaway: g.id })} className="panel block w-full space-y-2 rounded-xl p-4 text-left hover:border-border-hover">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-sm font-semibold text-foreground">{g.name}</span>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </div>
                  <p className="text-xs text-muted">
                    {g.accountUsername ? `@${g.accountUsername} · ` : ""}
                    {formatDateTime(g.windowStart)} – {formatDateTime(g.windowEnd)}
                  </p>
                  <p className="text-xs text-muted">
                    <b className="text-foreground">{g.entriesCount}</b> ishtirokchi · <b className="text-foreground">{g.eligibleCount}</b> qabul qilingan
                    {g.pendingCount ? <> · <b className="text-warning">{g.pendingCount}</b> tekshirilmoqda</> : null} · {g.winnersCount} g&apos;olib
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
        {loading ? "Yangilanmoqda…" : "Yangilash"}
      </button>
    </div>
  );
}
