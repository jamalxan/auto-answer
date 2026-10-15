"use client";

/**
 * Sandbox: a multi-turn chat against the account's real knowledge base. Every
 * AI turn shows what the engine decided (intent, confidence, cited facts,
 * extracted fields, score, handoff, filter) and what it cost. Nothing is sent
 * or stored. Scenario B / C presets are the TZ 64 E2E scripts.
 */

import { useRef, useState } from "react";
import { EmptyState, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import {
  describeValue,
  formatPercent,
  formatUsd,
  JAVOBAI_API,
  jsonInit,
  requestJson,
  TEMPERATURE_TEXT,
  uid,
  type AccountView,
  type SandboxResult,
} from "./shared";

interface Turn {
  key: string;
  role: "customer" | "assistant";
  text: string;
  result?: SandboxResult;
}

const SCENARIOS: { key: string; title: string; description: string; messages: string[] }[] = [
  {
    key: "B",
    title: "Scenario B — AI",
    description: "Narx so'raydi → AI javob beradi → kvalifikatsiya savoli → telefon → lead",
    messages: ["Salom, narxi qancha?", "Menga asosiy mahsulotingiz kerak, byudjet o'rtacha", "Ha, olaman. Raqamim +998901234567"],
  },
  {
    key: "C",
    title: "Scenario C — Handoff",
    description: "Menejer so'raydi → AI topshiradi → operator xabardor → AI jim",
    messages: ["Salom, narxi qancha?", "Menga menejer kerak, odam bilan gaplashmoqchiman", "Qachon yozadi?"],
  },
];

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="label-mono w-24 shrink-0 text-[10px] font-semibold text-muted">{label}</span>
      <span className="min-w-0 break-words text-foreground">{value}</span>
    </div>
  );
}

function TurnDetails({ r }: { r: SandboxResult }) {
  const t = TEMPERATURE_TEXT[r.temperature] ?? TEMPERATURE_TEXT.COLD;
  const handoffNeeded = Boolean(r.handoff?.needed);
  const handoffText = handoffNeeded ? `operatorga: ${r.handoff.reason ?? "sabab ko'rsatilmagan"}` : "yo'q — AI davom etadi";
  const signalsText = (r.signals ?? []).map((s) => `${s.signal} ${s.points >= 0 ? "+" : ""}${s.points}`).join(", ") || "—";
  return (
    <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-mono rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px]">{r.intent}</span>
        <span>ishonch {formatPercent(r.confidence)}</span>
        <Pill tone={t.tone}>
          {t.emoji} {t.label} {r.score}
        </Pill>
        {handoffNeeded && <Pill tone="warning">handoff</Pill>}
        {r.blockedBy && <Pill tone="error">filtr: {r.blockedBy}</Pill>}
        <span className="ml-auto text-muted">{formatUsd(r.costUsd)}</span>
      </div>
      <DetailRow label="Faktlar" value={r.usedFacts.length ? r.usedFacts.join(", ") : "— (KB'dan fakt ishlatilmadi)"} />
      <DetailRow label="Ajratildi" value={describeValue(r.extracted)} />
      <DetailRow label="Signallar" value={signalsText} />
      <DetailRow label="Handoff" value={handoffText} />
      {r.unknownQuestion && <DetailRow label="Javobsiz" value={r.unknownQuestion} />}
      <DetailRow label="Til" value={r.language} />
    </div>
  );
}

export default function SandboxTab({ account }: { account: AccountView | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("Salom, narxi qancha?");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(true);
  const seq = useRef(0);

  if (!account) {
    return (
      <div className="panel rounded-xl">
        <EmptyState title="Akkaunt yo'q" body="Avval Foundation → Ulanishlar bo'limida Instagram akkaunt ulang." />
      </div>
    );
  }

  /** One customer message on top of `history`; returns the new history or null on failure. */
  async function step(history: Turn[], text: string, mine: number): Promise<Turn[] | null> {
    const next = [...history, { key: uid(), role: "customer" as const, text }];
    setTurns(next);
    const res = await requestJson<SandboxResult>(
      `${JAVOBAI_API}/sandbox`,
      jsonInit("POST", {
        instagramAccountId: account!.id,
        messages: next.map((t) => ({ role: t.role, text: t.text })),
      })
    );
    if (mine !== seq.current) return null;
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    const withReply = [...next, { key: uid(), role: "assistant" as const, text: res.data.reply, result: res.data }];
    setTurns(withReply);
    return withReply;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const mine = ++seq.current;
    setRunning(true);
    setError(null);
    try {
      const result = await step(turns, trimmed, mine);
      if (result) setDraft("");
    } finally {
      if (mine === seq.current) setRunning(false);
    }
  }

  async function runScenario(messages: string[]) {
    const mine = ++seq.current;
    setRunning(true);
    setError(null);
    setTurns([]);
    try {
      let history: Turn[] = [];
      for (const text of messages) {
        const next = await step(history, text, mine);
        if (!next) break;
        history = next;
      }
    } finally {
      if (mine === seq.current) setRunning(false);
    }
  }

  const total = turns.reduce((sum, t) => sum + (t.result?.costUsd ?? 0), 0);

  return (
    <div className="space-y-4">
      {!account.profile.exists && (
        <Notice tone="warning">
          Bu akkaunt uchun bilim bazasi yo&apos;q — AI faktsiz javob bera olmaydi. Avval /assistant sahifasida profil yarating.
        </Notice>
      )}
      <Notice tone="info">
        Test haqiqiy bilim bazasi va modelga qarshi ishlaydi (LLM xarajati bor), lekin mijozga hech narsa yubormaydi va suhbatni
        saqlamaydi. Rejim ({account.mode}) testga ta&apos;sir qilmaydi.
      </Notice>

      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={secondaryButton}
            disabled={running}
            title={s.description}
            onClick={() => void runScenario(s.messages)}
          >
            ▶ {s.title}
          </button>
        ))}
        <button
          type="button"
          className={secondaryButton}
          disabled={running || turns.length === 0}
          onClick={() => {
            seq.current++;
            setTurns([]);
            setError(null);
          }}
        >
          Tozalash
        </button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={showDetails} onChange={(e) => setShowDetails(e.target.checked)} />
          Tafsilotlarni ko&apos;rsatish
        </label>
      </div>

      <div className="panel rounded-xl p-3">
        {turns.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">Mijoz sifatida yozing yoki ssenariyni ishga tushiring.</p>
        ) : (
          <ul className="space-y-2">
            {turns.map((t) => (
              <li
                key={t.key}
                className={`max-w-[92%] rounded-lg px-3 py-2 text-sm ${
                  t.role === "customer" ? "bg-surface-hover text-foreground" : "ml-auto bg-accent/10 text-foreground"
                }`}
              >
                <p className="label-mono text-[10px] text-muted">{t.role === "customer" ? "Mijoz" : "JavobAI"}</p>
                <p className="whitespace-pre-wrap break-words">{t.text || <span className="text-muted">(bo&apos;sh javob — AI jim)</span>}</p>
                {t.result && showDetails && <TurnDetails r={t.result} />}
              </li>
            ))}
            {running && (
              <li className="ml-auto max-w-[92%] rounded-lg bg-accent/10 px-3 py-2 text-sm text-muted">JavobAI o&apos;ylamoqda…</li>
            )}
          </ul>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          className={inputClass}
          value={draft}
          maxLength={2000}
          aria-label="Mijoz xabari"
          placeholder="Mijoz xabari…"
          disabled={running}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className={primaryButton} disabled={running || !draft.trim()}>
          {running ? "Kuting…" : "Yuborish"}
        </button>
      </form>
      {turns.length > 0 && <p className="text-xs text-muted">Shu suhbat xarajati: {formatUsd(total)}</p>}
    </div>
  );
}
