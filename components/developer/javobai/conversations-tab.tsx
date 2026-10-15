"use client";

/**
 * Conversations JavobAI has touched: score / temperature / handoff state in
 * the list, and a detail panel with the messages, score events, handoff
 * episodes, the lead and the operator actions.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, formatDateTime, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import {
  AUTHOR_TEXT,
  describeValue,
  HANDOFF_STATE_TEXT,
  JAVOBAI_API,
  jsonInit,
  requestJson,
  TEMPERATURE_TEXT,
  type AccountView,
  type ConversationDetail,
  type ConversationRow,
  type HandoffState,
  type Temperature,
} from "./shared";

const HANDOFF_FILTERS = Object.keys(HANDOFF_STATE_TEXT) as HandoffState[];
const TEMPERATURE_FILTERS = Object.keys(TEMPERATURE_TEXT) as Temperature[];

function TemperatureBadge({ temperature, score }: { temperature: Temperature; score: number }) {
  const t = TEMPERATURE_TEXT[temperature];
  return (
    <Pill tone={t.tone}>
      {t.emoji} {t.label} {score}
    </Pill>
  );
}

function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<{ conversation: ConversationDetail }>(`${JAVOBAI_API}/conversations/${id}`);
    if (mine !== seq.current) return;
    if (res.ok) setData(res.data.conversation);
    else setError(res.error);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per conversation
    setData(null);
    void load();
  }, [load]);

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${JAVOBAI_API}/conversations/${id}/${path}`, jsonInit("POST", body));
      if (!res.ok) setError(res.error);
    } finally {
      setBusy(false);
      void load();
      onChanged();
    }
  }

  const state = data?.state ?? null;

  return (
    <div className="panel flex max-h-[85vh] flex-col rounded-xl">
      <div className="flex items-start justify-between gap-2 border-b border-border p-4">
        <div className="min-w-0">
          <p className="truncate font-semibold text-foreground">
            {data ? (data.igUsername ? `@${data.igUsername}` : data.igName || data.igUserId) : "Suhbat"}
          </p>
          {data && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>@{data.accountUsername}</span>
              {state && <Pill tone={HANDOFF_STATE_TEXT[state.handoffState].tone}>{HANDOFF_STATE_TEXT[state.handoffState].label}</Pill>}
              {state && <TemperatureBadge temperature={state.temperature} score={state.score} />}
              {data.botPaused && <Pill tone="error">Bot pauzada (inbox)</Pill>}
            </div>
          )}
        </div>
        <button type="button" className={secondaryButton} onClick={onClose} aria-label="Yopish">
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {error && <Notice tone="error">{error}</Notice>}
        {!data ? (
          !error && <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : (
          <>
            {state && (
              <div className="flex flex-wrap gap-2">
                {state.handoffState === "HANDOFF_PENDING" && (
                  <button type="button" className={primaryButton} disabled={busy} onClick={() => void post("handoff", { action: "accept" })}>
                    Qabul qilish
                  </button>
                )}
                {(state.handoffState === "HANDOFF_PENDING" || state.handoffState === "OPERATOR_ACTIVE") && (
                  <ConfirmButton
                    label="Yopish"
                    question="Handoff yopilsinmi? Keyingi xabardan AI yana javob beradi."
                    confirmLabel="Yopish"
                    busy={busy}
                    onConfirm={() => void post("handoff", { action: "close", resumeAi: true })}
                  />
                )}
                {state.handoffState === "CLOSED" && (
                  <button type="button" className={secondaryButton} disabled={busy} onClick={() => void post("handoff", { action: "reopen" })}>
                    AI&apos;ni qayta yoqish
                  </button>
                )}
                {state.temperature !== "CUSTOMER" && (
                  <ConfirmButton
                    label="✅ Mijoz bo'ldi"
                    question="Mijoz deb belgilansinmi?"
                    confirmLabel="Ha"
                    busy={busy}
                    onConfirm={() => void post("temperature", { temperature: "CUSTOMER" })}
                  />
                )}
                {state.temperature !== "LOST" && (
                  <ConfirmButton
                    label="⛔ Yo'qotildi"
                    question="Yo'qotilgan deb belgilansinmi?"
                    confirmLabel="Ha"
                    danger
                    busy={busy}
                    onConfirm={() => void post("temperature", { temperature: "LOST" })}
                  />
                )}
              </div>
            )}
            {!state && <Notice tone="info">Bu suhbatda JavobAI hali ishlamagan — faqat production tarixi ko&apos;rinadi.</Notice>}

            <section>
              <h3 className="label-mono mb-2 text-[11px] font-semibold text-muted">Xabarlar (oxirgi 50)</h3>
              <ul className="space-y-1.5">
                {data.messages.map((m) => (
                  <li
                    key={m.id}
                    className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                      m.author === "CUSTOMER"
                        ? "bg-surface-hover text-foreground"
                        : m.author === "OPERATOR"
                          ? "ml-auto bg-gold/10 text-foreground"
                          : "ml-auto bg-accent/10 text-foreground"
                    }`}
                  >
                    <p className="label-mono text-[10px] text-muted">
                      {AUTHOR_TEXT[m.author]} · {formatDateTime(m.createdAt)}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  </li>
                ))}
              </ul>
            </section>

            {state && (
              <section className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border p-3 text-xs">
                  <p className="label-mono mb-1 font-semibold text-muted">Holat</p>
                  <p className="text-foreground">
                    {state.turns} AI javob · {state.unknownStreak} javobsiz ketma-ket · sikl {state.leadCycle}
                  </p>
                  <p className="mt-1 text-muted">Ajratilgan: {describeValue(state.extracted)}</p>
                  {state.summary && <p className="mt-1 text-muted">Xulosa: {state.summary}</p>}
                </div>
                <div className="rounded-lg border border-border p-3 text-xs">
                  <p className="label-mono mb-1 font-semibold text-muted">Ball tarixi</p>
                  {state.scoreEvents.length === 0 ? (
                    <p className="text-muted">Hali signal yo&apos;q.</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {state.scoreEvents.map((e) => (
                        <li key={e.id} className="flex justify-between gap-2 text-foreground">
                          <span className="label-mono">{e.signal}</span>
                          <span className={e.points >= 0 ? "text-success" : "text-error"}>
                            {e.points >= 0 ? "+" : ""}
                            {e.points}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            )}

            {data.handoffs.length > 0 && (
              <section className="rounded-lg border border-border p-3 text-xs">
                <p className="label-mono mb-1 font-semibold text-muted">Handofflar</p>
                <ul className="space-y-1">
                  {data.handoffs.map((h) => (
                    <li key={h.id} className="text-foreground">
                      {formatDateTime(h.openedAt)} · {h.reason} · {h.status}
                      {h.acceptedAt ? ` · qabul: ${formatDateTime(h.acceptedAt)}` : ""}
                      {h.closedAt ? ` · yopildi: ${formatDateTime(h.closedAt)}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.lead && (
              <section className="rounded-lg border border-border p-3 text-xs">
                <p className="label-mono mb-1 font-semibold text-muted">Lead</p>
                <p className="text-foreground">
                  {data.lead.isTest && "🧪 TEST · "}
                  {data.lead.name ?? "nomsiz"} · {data.lead.phoneE164 ?? "telefon yo'q"} · {data.lead.productInterest ?? "—"} ·{" "}
                  {data.lead.status}
                </p>
                {data.lead.aiInsight && (
                  <p className="mt-1 text-muted">
                    {TEMPERATURE_TEXT[data.lead.aiInsight.temperature].emoji} {data.lead.aiInsight.temperature} {data.lead.aiInsight.score}
                    {data.lead.aiInsight.email ? ` · ${data.lead.aiInsight.email}` : ""}
                    {data.lead.aiInsight.budget ? ` · byudjet: ${data.lead.aiInsight.budget}` : ""}
                    {data.lead.aiInsight.location ? ` · ${data.lead.aiInsight.location}` : ""}
                  </p>
                )}
                {data.lead.summary && <p className="mt-1 whitespace-pre-wrap text-muted">{data.lead.summary}</p>}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function ConversationsTab({
  accounts,
  initialConversationId,
}: {
  accounts: AccountView[];
  initialConversationId: string | null;
}) {
  const [accountId, setAccountId] = useState("");
  const [handoffState, setHandoffState] = useState("");
  const [temperature, setTemperature] = useState("");
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialConversationId);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const params = new URLSearchParams();
    if (accountId) params.set("instagramAccountId", accountId);
    if (handoffState) params.set("handoffState", handoffState);
    if (temperature) params.set("temperature", temperature);
    params.set("limit", "100");
    const res = await requestJson<{ conversations: ConversationRow[] }>(`${JAVOBAI_API}/conversations?${params.toString()}`);
    if (mine !== seq.current) return;
    if (res.ok) setRows(res.data.conversations);
    else setError(res.error);
  }, [accountId, handoffState, temperature]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per filter
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        <select className={inputClass} value={accountId} aria-label="Akkaunt" onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Barcha akkauntlar</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.username}
            </option>
          ))}
        </select>
        <select className={inputClass} value={handoffState} aria-label="Handoff holati" onChange={(e) => setHandoffState(e.target.value)}>
          <option value="">Barcha holatlar</option>
          {HANDOFF_FILTERS.map((s) => (
            <option key={s} value={s}>
              {HANDOFF_STATE_TEXT[s].label}
            </option>
          ))}
        </select>
        <select className={inputClass} value={temperature} aria-label="Harorat" onChange={(e) => setTemperature(e.target.value)}>
          <option value="">Barcha haroratlar</option>
          {TEMPERATURE_FILTERS.map((t) => (
            <option key={t} value={t}>
              {TEMPERATURE_TEXT[t].emoji} {TEMPERATURE_TEXT[t].label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span>{error}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      <div className={`grid gap-4 ${selected ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : ""}`}>
        <div className={selected ? "hidden lg:block" : ""}>
          {rows === null ? (
            !error && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
          ) : rows.length === 0 ? (
            <div className="panel rounded-xl">
              <EmptyState
                title="Suhbat yo'q"
                body="JavobAI SHADOW yoki LIVE rejimda birinchi xabarni qayta ishlagach, suhbatlar shu yerda ko'rinadi."
              />
            </div>
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(row.id)}
                    aria-pressed={selected === row.id}
                    className={`panel w-full rounded-xl p-3 text-left ${selected === row.id ? "ring-1 ring-accent" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{row.igUsername ? `@${row.igUsername}` : row.igName || row.igUserId}</span>
                      <TemperatureBadge temperature={row.temperature} score={row.score} />
                      <Pill tone={HANDOFF_STATE_TEXT[row.handoffState].tone}>{HANDOFF_STATE_TEXT[row.handoffState].label}</Pill>
                      {row.botPaused && <Pill tone="error">pauza</Pill>}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted">
                      @{row.accountUsername} · {row.turns} AI javob · {formatDateTime(row.updatedAt)}
                    </p>
                    {row.lastMessage && (
                      <p className="mt-1 truncate text-sm text-muted">
                        <span className="label-mono text-[10px]">{AUTHOR_TEXT[row.lastMessage.author as keyof typeof AUTHOR_TEXT] ?? row.lastMessage.author}</span>{" "}
                        {row.lastMessage.text}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected && <Detail id={selected} onClose={() => setSelected(null)} onChanged={() => void load()} />}
      </div>
    </div>
  );
}
