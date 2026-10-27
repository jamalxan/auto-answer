"use client";

/**
 * Trust ladder (audit 2026-10-26) for one account: every intent's mode and
 * how close it is to AUTO, the copilot drafts waiting for a human, the facts
 * the AI noticed in operator replies (owner approves), the golden eval set
 * and the comment guard's log.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChipInput, EmptyState, Field, Pill, formatDateTime, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { JAVOBAI_API, KNOWLEDGE_KIND_TEXT, jsonInit, requestJson, type AccountView, type KnowledgeKind } from "./shared";

type Mode = "OBSERVE" | "COPILOT" | "AUTO";

interface IntentRow {
  intent: string;
  label: string;
  neverAuto: boolean;
  early: boolean;
  mode: Mode;
  allowed: Mode[];
  readiness: { samples: number; judged: number; matched: number; matchRate: number | null; criticalRecent: number; hasFact: boolean; ready: boolean; missing: string[] };
  demotedAt: string | null;
  demoteReason: string | null;
}
interface Draft {
  id: string;
  conversationId: string;
  text: string;
  intent: string | null;
  createdAt: string;
}
interface Fact {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  source: string;
  evidence: string | null;
  validUntil: string | null;
  createdAt: string;
}
interface EvalCase {
  id: string;
  question: string;
  expectedIntent: string | null;
  mustContain: string[];
  mustNotContain: string[];
  source: string;
  active: boolean;
}
interface EvalRun {
  id: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  model: string;
  startedAt: string;
  results: Array<{ caseId: string; question: string; reply: string; intent: string; pass: boolean; reasons: string[] }>;
}
interface Critical {
  id: string;
  intent: string | null;
  customerText: string;
  aiReply: string | null;
  operatorReply: string | null;
  critical: string | null;
  judgeNotes: string | null;
  createdAt: string;
}
interface Moderation {
  id: string;
  text: string;
  verdict: string;
  action: string;
  error: string | null;
  createdAt: string;
}
interface LadderResponse {
  intents: IntentRow[];
  drafts: Draft[];
  facts: Fact[];
  cases: EvalCase[];
  runs: EvalRun[];
  critical: Critical[];
  moderations: Moderation[];
}

const MODE_TEXT: Record<Mode, { label: string; hint: string }> = {
  OBSERVE: { label: "Kuzatish", hint: "AI jim yozadi, operator javobi bilan solishtiriladi" },
  COPILOT: { label: "Copilot", hint: "Qoralama — bir bosishda yuboriladi" },
  AUTO: { label: "Avto", hint: "AI o'zi yuboradi" },
};

const CRITICAL_TEXT: Record<string, string> = {
  wrong_price: "Noto'g'ri narx",
  wrong_fact: "Noto'g'ri fakt",
  promise: "Bermagan va'da",
  tone: "Ohang",
  policy: "Qoida buzilishi",
};

const FACT_KINDS: KnowledgeKind[] = ["PRICE", "HOURS", "DELIVERY", "CONTACT", "BRANCH", "DISCOUNT", "TERMS", "POLICY", "OTHER"];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="panel space-y-3 rounded-xl p-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export default function LadderTab({ account }: { account: AccountView | null }) {
  const [data, setData] = useState<LadderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!account) return;
    const mine = ++seq.current;
    const res = await requestJson<LadderResponse>(`${JAVOBAI_API}/ladder?accountId=${account.id}`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else setError(res.error);
  }, [account]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  // A running eval fills in case by case: poll while it runs.
  const running = data?.runs.some((r) => r.status === "RUNNING");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [running, load]);

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    try {
      const res = await requestJson(`${JAVOBAI_API}/ladder`, jsonInit("POST", body));
      if (!res.ok) setError(res.error);
      await load();
      return res.ok;
    } finally {
      setBusy(null);
    }
  }

  if (!account) return <EmptyState title="Akkaunt yo'q" body="Avval Instagram akkaunt ulang." />;
  if (!data) return <p className="py-10 text-center text-sm text-muted">{error ?? "Yuklanmoqda…"}</p>;

  const ladderOn = account.config.ladderEnabled;
  const intents = [...data.intents].sort((a, b) => Number(b.early) - Number(a.early) || Number(a.neverAuto) - Number(b.neverAuto));

  return (
    <div className="space-y-5">
      {!ladderOn && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Bu akkauntda ishonch zinapoyasi o&apos;chiq — LIVE rejimda hamma javob avvalgidek yuboriladi. Yoqish: «Akkauntlar» → sozlamalar → «Ishonch zinapoyasi».
        </div>
      )}
      {error && <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</div>}

      <Section
        title="Mavzular bo'yicha rejim"
        hint="Avto faqat shunda: ≥50 baholangan namuna, operator javobiga ≥90% moslik, oxirgi 100 tada 0 jiddiy xato va kerakli fakt tasdiqlangan. Jiddiy xato bo'lsa avto o'zi copilot'ga qaytadi."
      >
        <div className="divide-y divide-border">
          {intents.map((row) => (
            <div key={row.intent} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-foreground">
                  {row.label} <span className="label-mono text-[10px] text-muted">{row.intent}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  Baholangan {row.readiness.judged}/50 · moslik {row.readiness.matchRate === null ? "—" : `${Math.round(row.readiness.matchRate * 100)}%`} · jiddiy xato{" "}
                  {row.readiness.criticalRecent} · fakt {row.readiness.hasFact ? "bor" : "yo'q"}
                </p>
                {row.readiness.missing.length > 0 && <p className="mt-0.5 text-xs text-warning">{row.readiness.missing.join(" · ")}</p>}
                {row.demotedAt && (
                  <p className="mt-0.5 text-xs text-error">
                    Avto to&apos;xtatilgan {formatDateTime(row.demotedAt)}: {row.demoteReason}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                {(["OBSERVE", "COPILOT", "AUTO"] as Mode[]).map((mode) => {
                  const allowed = row.allowed.includes(mode);
                  const active = row.mode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      title={allowed ? MODE_TEXT[mode].hint : row.readiness.missing[0]}
                      disabled={!allowed || active || busy !== null}
                      onClick={() => void act(`mode:${row.intent}`, { action: "set_mode", accountId: account.id, intent: row.intent, mode })}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                        active ? "border-accent bg-accent/15 text-foreground" : "border-border text-muted hover:text-foreground disabled:opacity-40"
                      }`}
                    >
                      {MODE_TEXT[mode].label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={`Copilot qoralamalari (${data.drafts.length})`} hint="Telegram'dagi tugmalar bilan bir xil: yuborish, tahrirlab yuborish yoki bekor qilish.">
        {data.drafts.length === 0 ? (
          <p className="text-sm text-muted">Kutayotgan qoralama yo&apos;q.</p>
        ) : (
          data.drafts.map((d) => <DraftCard key={d.id} draft={d} busy={busy} onAct={act} />)
        )}
      </Section>

      <Section title={`Fakt nomzodlari (${data.facts.length})`} hint="Operator javoblaridan topilgan yoki menejer Telegram'dan taklif qilgan. Tasdiqlanmaguncha AI ishlatmaydi.">
        {data.facts.length === 0 ? <p className="text-sm text-muted">Yangi nomzod yo&apos;q.</p> : data.facts.map((f) => <FactCard key={f.id} fact={f} busy={busy} onAct={act} />)}
      </Section>

      {data.critical.length > 0 && (
        <Section title="Oxirgi jiddiy xatolar" hint="AI qoralamasi operator javobidan muhim farq qilgan holatlar.">
          {data.critical.map((c) => (
            <div key={c.id} className="space-y-1 rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="error">{CRITICAL_TEXT[c.critical ?? ""] ?? c.critical}</Pill>
                <span className="text-xs text-muted">{c.intent} · {formatDateTime(c.createdAt)}</span>
              </div>
              <p className="text-muted">Mijoz: {c.customerText}</p>
              <p>AI: {c.aiReply}</p>
              <p>Operator: {c.operatorReply}</p>
              {c.judgeNotes && <p className="text-xs text-muted">{c.judgeNotes}</p>}
              <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void act(`case:${c.id}`, { action: "case_from_sample", shadowTurnId: c.id })}>
                Golden savolga qo&apos;shish
              </button>
            </div>
          ))}
        </Section>
      )}

      <EvalSection accountId={account.id} cases={data.cases} runs={data.runs} intents={data.intents} busy={busy} onAct={act} />

      <Section title="Kommentlar nazorati" hint="Haqoratli kommentlar yashiriladi, shikoyatlar Telegram'ga boradi (akkaunt sozlamalarida yoqiladi).">
        {data.moderations.length === 0 ? (
          <p className="text-sm text-muted">Hali hech narsa bo&apos;lmagan.</p>
        ) : (
          <div className="divide-y divide-border text-sm">
            {data.moderations.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                <Pill tone={m.verdict === "offensive" ? "error" : "warning"}>{m.verdict === "offensive" ? "Haqorat" : "Shikoyat"}</Pill>
                <Pill tone={m.action === "failed" ? "error" : "muted"}>{m.action}</Pill>
                <span className="min-w-0 flex-1 break-words">{m.text}</span>
                <span className="text-xs text-muted">{formatDateTime(m.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

type Act = (key: string, body: Record<string, unknown>) => Promise<boolean>;

function DraftCard({ draft, busy, onAct }: { draft: Draft; busy: string | null; onAct: Act }) {
  const [text, setText] = useState(draft.text);
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Pill tone="warning">{draft.intent ?? "—"}</Pill>
        {formatDateTime(draft.createdAt)}
        <a className="underline" href={`/inbox?conversation=${draft.conversationId}`}>
          Suhbat
        </a>
      </div>
      <textarea className={`${inputClass} min-h-[80px]`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <button type="button" className={primaryButton} disabled={busy !== null || !text.trim()} onClick={() => void onAct(`draft:${draft.id}`, { action: "draft_send", id: draft.id, text })}>
          {text.trim() === draft.text.trim() ? "Yuborish" : "Tahrirlab yuborish"}
        </button>
        <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void onAct(`drop:${draft.id}`, { action: "draft_drop", id: draft.id })}>
          Bekor qilish
        </button>
      </div>
    </div>
  );
}

function FactCard({ fact, busy, onAct }: { fact: Fact; busy: string | null; onAct: Act }) {
  const [title, setTitle] = useState(fact.title);
  const [body, setBody] = useState(fact.body);
  const [kind, setKind] = useState<KnowledgeKind>(fact.kind);
  const [validUntil, setValidUntil] = useState(fact.validUntil ? fact.validUntil.slice(0, 10) : "");
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Pill tone="muted">{fact.source === "manager_reply" ? "Menejer" : "Operator javobidan"}</Pill>
        {formatDateTime(fact.createdAt)}
      </div>
      {fact.evidence && <p className="text-xs text-muted">«{fact.evidence.slice(0, 300)}»</p>}
      <div className="grid gap-2 sm:grid-cols-[1fr_10rem_10rem]">
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sarlavha" />
        <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)}>
          {FACT_KINDS.map((k) => (
            <option key={k} value={k}>
              {KNOWLEDGE_KIND_TEXT[k]}
            </option>
          ))}
        </select>
        <input className={inputClass} type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} title="Amal qilish muddati (bo'sh = muddatsiz)" />
      </div>
      <textarea className={`${inputClass} min-h-[60px]`} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex gap-2">
        <button
          type="button"
          className={primaryButton}
          disabled={busy !== null}
          onClick={() => void onAct(`fact:${fact.id}`, { action: "fact_approve", id: fact.id, title, body, kind, validUntil: validUntil ? `${validUntil}T23:59:59` : null })}
        >
          Tasdiqlash → bilim bazasi
        </button>
        <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void onAct(`reject:${fact.id}`, { action: "fact_reject", id: fact.id })}>
          Rad etish
        </button>
      </div>
    </div>
  );
}

function EvalSection({ accountId, cases, runs, intents, busy, onAct }: { accountId: string; cases: EvalCase[]; runs: EvalRun[]; intents: IntentRow[]; busy: string | null; onAct: Act }) {
  const [question, setQuestion] = useState("");
  const [expectedIntent, setExpectedIntent] = useState("");
  const [mustContain, setMustContain] = useState<string[]>([]);
  const [mustNotContain, setMustNotContain] = useState<string[]>([]);
  const last = runs[0];

  async function add() {
    const ok = await onAct("case:new", { action: "case_create", accountId, question, expectedIntent: expectedIntent || null, mustContain, mustNotContain });
    if (ok) {
      setQuestion("");
      setMustContain([]);
      setMustNotContain([]);
    }
  }

  return (
    <Section title={`Golden savollar (${cases.length})`} hint="Prompt yoki model o'zgarganda shu savollar qayta ishlatiladi — regressiya bo'lsa mijozga yetmasdan ko'rinadi.">
      <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
        <Field label="Mijoz savoli">
          <input className={inputClass} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Divan Milan necha pul?" />
        </Field>
        <Field label="Kutilgan intent">
          <select className={inputClass} value={expectedIntent} onChange={(e) => setExpectedIntent(e.target.value)}>
            <option value="">— tekshirilmaydi —</option>
            {intents.map((i) => (
              <option key={i.intent} value={i.intent}>
                {i.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Javobda bo'lishi shart">
          <ChipInput values={mustContain} onChange={setMustContain} placeholder="4 500 000" max={10} />
        </Field>
        <Field label="Javobda bo'lmasligi kerak">
          <ChipInput values={mustNotContain} onChange={setMustNotContain} placeholder="bepul" max={10} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondaryButton} disabled={busy !== null || !question.trim()} onClick={() => void add()}>
          Savol qo&apos;shish
        </button>
        <button type="button" className={primaryButton} disabled={busy !== null || cases.length === 0 || last?.status === "RUNNING"} onClick={() => void onAct("eval:run", { action: "eval_run", accountId })}>
          {last?.status === "RUNNING" ? `Ishlayapti… ${last.passed + last.failed}/${last.total}` : "Eval'ni ishga tushirish"}
        </button>
      </div>

      {cases.length > 0 && (
        <div className="divide-y divide-border text-sm">
          {cases.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className={`min-w-0 flex-1 break-words ${c.active ? "" : "text-muted line-through"}`}>{c.question}</span>
              {c.expectedIntent && <Pill tone="muted">{c.expectedIntent}</Pill>}
              {c.mustContain.length > 0 && <span className="text-xs text-success">+{c.mustContain.join(", ")}</span>}
              {c.mustNotContain.length > 0 && <span className="text-xs text-error">−{c.mustNotContain.join(", ")}</span>}
              <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void onAct(`toggle:${c.id}`, { action: "case_update", id: c.id, active: !c.active })}>
                {c.active ? "O'chirish" : "Yoqish"}
              </button>
              <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void onAct(`del:${c.id}`, { action: "case_delete", id: c.id })}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {last && (
        <div className="space-y-2">
          <p className="text-sm">
            Oxirgi run: <b className={last.failed ? "text-error" : "text-success"}>{last.passed}/{last.total}</b> o&apos;tdi · {last.model} · {formatDateTime(last.startedAt)} · {last.status}
          </p>
          {last.results
            .filter((r) => !r.pass)
            .map((r) => (
              <div key={r.caseId} className="rounded-lg border border-error/30 p-2 text-xs">
                <p className="font-medium text-foreground">{r.question}</p>
                <p className="text-muted">AI ({r.intent}): {r.reply || "—"}</p>
                <p className="text-error">{r.reasons.join(" · ")}</p>
              </div>
            ))}
        </div>
      )}
    </Section>
  );
}
