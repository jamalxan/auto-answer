"use client";

/**
 * SHADOW review: what production answered next to what JavobAI would have
 * answered, with the intent / confidence / score / handoff decision and cost
 * of every turn. Nothing here was sent to a customer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, formatDateTime, Pill, secondaryButton } from "@/components/developer/ui";
import { formatPercent, formatUsd, JAVOBAI_API, requestJson, type ShadowResponse, type ShadowTurn } from "./shared";

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="panel min-w-0 rounded-xl px-4 py-3">
      <p className="label-mono break-words text-[10px] font-semibold text-muted">{label}</p>
      <p className={`mt-1 break-words text-xl font-bold leading-tight ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function Reply({ label, text, tone }: { label: string; text: string | null; tone: string }) {
  return (
    <div className={`rounded-lg border p-2.5 ${tone}`}>
      <p className="label-mono mb-1 text-[10px] font-semibold text-muted">{label}</p>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{text ?? <span className="text-muted">— javob yo&apos;q</span>}</p>
    </div>
  );
}

function TurnCard({ turn }: { turn: ShadowTurn }) {
  const same = turn.productionReply && turn.aiReply && turn.productionReply.trim() === turn.aiReply.trim();
  return (
    <li className="panel space-y-2 rounded-xl p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{formatDateTime(turn.createdAt)}</span>
        {turn.intent && <span className="label-mono rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px]">{turn.intent}</span>}
        {turn.confidence !== null && <span>ishonch {formatPercent(turn.confidence)}</span>}
        {turn.score !== null && <span>ball {turn.score}</span>}
        {turn.handoff && <Pill tone="warning">handoff: {turn.handoff}</Pill>}
        {turn.error && <Pill tone="error">xato</Pill>}
        {same && <Pill tone="success">bir xil</Pill>}
        <span className="ml-auto">{formatUsd(turn.costUsd)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words rounded-lg bg-surface-hover px-3 py-2 text-sm text-foreground">
        <span className="label-mono text-[10px] text-muted">Mijoz · </span>
        {turn.customerText}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Reply label="Production javobi" text={turn.productionReply} tone="border-border" />
        <Reply label="JavobAI javobi" text={turn.aiReply} tone="border-accent/40 bg-accent/5" />
      </div>
      {turn.error && <p className="text-xs text-error">{turn.error}</p>}
    </li>
  );
}

export default function ShadowTab() {
  const [data, setData] = useState<ShadowResponse | null>(null);
  const [turns, setTurns] = useState<ShadowTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const mine = ++seq.current;
    setError(null);
    if (cursor) setLoadingMore(true);
    try {
      const url = `${JAVOBAI_API}/shadow?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await requestJson<ShadowResponse>(url);
      if (mine !== seq.current) return;
      if (res.ok) {
        setData(res.data);
        setTurns((prev) => (cursor ? [...prev, ...res.data.turns] : res.data.turns));
      } else setError(res.error);
    } finally {
      if (mine === seq.current) setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span>{error}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}
      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Shadow navbatlar" value={data.stats.count} />
          <Stat label="O'rtacha ishonch" value={formatPercent(data.stats.avgConfidence)} />
          <Stat label="Handoff ulushi" value={formatPercent(data.stats.handoffRate)} tone={data.stats.handoffs ? "text-warning" : undefined} />
          <Stat label="Xatolar" value={data.stats.errors} tone={data.stats.errors ? "text-error" : undefined} />
          <Stat label="Xarajat" value={formatUsd(data.stats.costUsd)} />
        </div>
      )}
      {data === null ? (
        !error && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : turns.length === 0 ? (
        <div className="panel rounded-xl">
          <EmptyState
            title="Hali shadow navbat yo'q"
            body="Akkauntni SHADOW rejimga o'tkazing: production javob beraveradi, JavobAI'ning javobi shu yerda yonma-yon ko'rinadi."
          />
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {turns.map((turn) => (
              <TurnCard key={turn.id} turn={turn} />
            ))}
          </ul>
          {data.nextCursor && (
            <div className="text-center">
              <button type="button" className={secondaryButton} disabled={loadingMore} onClick={() => void load(data.nextCursor!)}>
                {loadingMore ? "Yuklanmoqda…" : "Yana ko'rsatish"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
