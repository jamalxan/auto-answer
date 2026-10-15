"use client";

/**
 * Handoff (TZ 25): the business rules that force a handoff, and the threads
 * waiting for or held by an operator with "Qabul qilish" / "Yopish".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChipInput,
  EmptyState,
  Field,
  formatDateTime,
  inputClass,
  Pill,
  primaryButton,
  secondaryButton,
  Toggle,
} from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import {
  HANDOFF_STATE_TEXT,
  JAVOBAI_API,
  jsonInit,
  requestJson,
  RULE_KIND_TEXT,
  TEMPERATURE_TEXT,
  type ConversationRow,
  type HandoffRule,
  type RuleKind,
  type RuleValue,
} from "./shared";

interface RulesResponse {
  rules: HandoffRule[];
  intents: string[];
  reasons: Record<string, string>;
}

const KINDS = Object.keys(RULE_KIND_TEXT) as RuleKind[];

function defaultValue(kind: RuleKind): RuleValue {
  switch (kind) {
    case "KEYWORD":
      return { keywords: [] };
    case "INTENT":
      return { intents: [] };
    case "SCORE":
      return { min: 80 };
    case "UNKNOWN_COUNT":
      return { count: 2 };
    case "OFF_HOURS":
      return { from: "18:00", to: "09:00" };
  }
}

function describeRule(rule: HandoffRule): string {
  const v = rule.value as Record<string, unknown>;
  switch (rule.kind) {
    case "KEYWORD":
      return (v.keywords as string[]).map((k) => `“${k}”`).join(", ");
    case "INTENT":
      return (v.intents as string[]).join(", ");
    case "SCORE":
      return `ball ≥ ${v.min}`;
    case "UNKNOWN_COUNT":
      return `${v.count} ta ketma-ket javobsiz savol`;
    case "OFF_HOURS":
      return `${v.from} – ${v.to}`;
  }
}

function RuleValueEditor({
  kind,
  value,
  intents,
  onChange,
}: {
  kind: RuleKind;
  value: RuleValue;
  intents: string[];
  onChange: (value: RuleValue) => void;
}) {
  const v = value as Record<string, unknown>;
  if (kind === "KEYWORD") {
    return (
      <Field label="Kalit so'zlar" hint="Enter yoki vergul bilan ajrating, ko'pi bilan 20 ta.">
        <ChipInput values={(v.keywords as string[]) ?? []} onChange={(keywords) => onChange({ keywords })} max={20} placeholder="menejer, odam, shikoyat" />
      </Field>
    );
  }
  if (kind === "INTENT") {
    const chosen = (v.intents as string[]) ?? [];
    return (
      <Field label="Intentlar">
        <div className="flex flex-wrap gap-1.5">
          {intents.map((intent) => {
            const on = chosen.includes(intent);
            return (
              <button
                key={intent}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ intents: on ? chosen.filter((i) => i !== intent) : [...chosen, intent] })}
                className={`label-mono rounded-full border px-2.5 py-1 text-[11px] ${
                  on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
                }`}
              >
                {intent}
              </button>
            );
          })}
        </div>
      </Field>
    );
  }
  if (kind === "SCORE") {
    return (
      <Field label="Minimal ball (1–100)">
        <input type="number" min={1} max={100} className={inputClass} value={(v.min as number) ?? 80} onChange={(e) => onChange({ min: Number(e.target.value) || 1 })} />
      </Field>
    );
  }
  if (kind === "UNKNOWN_COUNT") {
    return (
      <Field label="Javobsiz savollar soni (1–5)">
        <input type="number" min={1} max={5} className={inputClass} value={(v.count as number) ?? 2} onChange={(e) => onChange({ count: Number(e.target.value) || 1 })} />
      </Field>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Dan (HH:MM)">
        <input type="time" className={inputClass} value={(v.from as string) ?? ""} onChange={(e) => onChange({ from: e.target.value, to: (v.to as string) ?? "" })} />
      </Field>
      <Field label="Gacha (HH:MM)" hint="Toshkent vaqti. 18:00 – 09:00 = kechqurundan ertalabgacha.">
        <input type="time" className={inputClass} value={(v.to as string) ?? ""} onChange={(e) => onChange({ from: (v.from as string) ?? "", to: e.target.value })} />
      </Field>
    </div>
  );
}

function NewRuleForm({ intents, onCreated }: { intents: string[]; onCreated: () => void }) {
  const [kind, setKind] = useState<RuleKind>("KEYWORD");
  const [value, setValue] = useState<RuleValue>(defaultValue("KEYWORD"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${JAVOBAI_API}/handoff-rules`, jsonInit("POST", { kind, value, active: true }));
      if (res.ok) {
        setValue(defaultValue(kind));
        onCreated();
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-semibold text-foreground">Yangi qoida</p>
      <Field label="Turi" hint={RULE_KIND_TEXT[kind].description}>
        <select
          className={inputClass}
          value={kind}
          onChange={(e) => {
            const next = e.target.value as RuleKind;
            setKind(next);
            setValue(defaultValue(next));
          }}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {RULE_KIND_TEXT[k].title}
            </option>
          ))}
        </select>
      </Field>
      <RuleValueEditor kind={kind} value={value} intents={intents} onChange={setValue} />
      <button type="button" className={primaryButton} disabled={busy} onClick={() => void create()}>
        {busy ? "Saqlanmoqda…" : "Qoida qo'shish"}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function OpenHandoffRow({ row, onChanged, onOpen }: { row: ConversationRow; onChanged: () => void; onOpen: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "accept" | "close") {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${JAVOBAI_API}/conversations/${row.id}/handoff`, jsonInit("POST", { action }));
      if (!res.ok) setError(res.error);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const temp = TEMPERATURE_TEXT[row.temperature];
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="font-medium text-foreground hover:text-accent" onClick={() => onOpen(row.id)}>
              {row.igUsername ? `@${row.igUsername}` : row.igName || row.igUserId}
            </button>
            <Pill tone={HANDOFF_STATE_TEXT[row.handoffState].tone}>{HANDOFF_STATE_TEXT[row.handoffState].label}</Pill>
            <Pill tone={temp.tone}>
              {temp.emoji} {temp.label} {row.score}
            </Pill>
          </div>
          <p className="mt-1 truncate text-xs text-muted">
            @{row.accountUsername} · {formatDateTime(row.updatedAt)}
            {row.lastMessage ? ` · ${row.lastMessage.text}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {row.handoffState === "HANDOFF_PENDING" && (
            <button type="button" className={primaryButton} disabled={busy} onClick={() => void act("accept")}>
              Qabul qilish
            </button>
          )}
          <ConfirmButton
            label="Yopish"
            question="Handoff yopilsinmi? Keyingi xabardan AI yana javob beradi."
            confirmLabel="Yopish"
            busy={busy}
            onConfirm={() => void act("close")}
          />
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </li>
  );
}

export default function HandoffTab({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const [rules, setRules] = useState<RulesResponse | null>(null);
  const [open, setOpen] = useState<ConversationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const [r, pending, active] = await Promise.all([
      requestJson<RulesResponse>(`${JAVOBAI_API}/handoff-rules`),
      requestJson<{ conversations: ConversationRow[] }>(`${JAVOBAI_API}/conversations?handoffState=HANDOFF_PENDING&limit=100`),
      requestJson<{ conversations: ConversationRow[] }>(`${JAVOBAI_API}/conversations?handoffState=OPERATOR_ACTIVE&limit=100`),
    ]);
    if (mine !== seq.current) return;
    const failed = [r, pending, active].find((res) => !res.ok);
    if (failed && !failed.ok) setError(failed.error);
    if (r.ok) setRules(r.data);
    if (pending.ok && active.ok) setOpen([...pending.data.conversations, ...active.data.conversations]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  async function patchRule(id: string, body: unknown) {
    const res = await requestJson(`${JAVOBAI_API}/handoff-rules/${id}`, jsonInit("PATCH", body));
    if (!res.ok) setError(res.error);
    void load();
  }

  async function deleteRule(id: string) {
    const res = await requestJson(`${JAVOBAI_API}/handoff-rules/${id}`, { method: "DELETE" });
    if (!res.ok) setError(res.error);
    void load();
  }

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

      <section className="panel space-y-3 rounded-xl p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Ochiq handofflar</h2>
          <p className="mt-1 text-xs text-muted">
            Operator kutilayotgan va operator yozayotgan suhbatlar. Telegram&apos;dagi &quot;Qabul qildim&quot; / &quot;Yopish&quot; tugmalari
            ham shu yerga ta&apos;sir qiladi.
          </p>
        </div>
        {open === null ? (
          <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : open.length === 0 ? (
          <EmptyState title="Ochiq handoff yo'q" body="AI hamma suhbatni o'zi olib bormoqda." />
        ) : (
          <ul className="space-y-2">
            {open.map((row) => (
              <OpenHandoffRow key={row.id} row={row} onChanged={() => void load()} onOpen={onOpenConversation} />
            ))}
          </ul>
        )}
      </section>

      <section className="panel space-y-3 rounded-xl p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Biznes qoidalari</h2>
          <p className="mt-1 text-xs text-muted">
            Qoidalardan tashqari AI o&apos;zi ham topshiradi: operator so&apos;raganda, shikoyat / nozik vaziyatda, javob topa olmasa,
            telefon olingach sotib olishga tayyor bo&apos;lganda, &quot;Scoring&quot; dagi baldan oshsa, suhbat limiti tugasa.
          </p>
        </div>
        {rules === null ? (
          <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : rules.rules.length === 0 ? (
          <p className="text-sm text-muted">Hali qoida yo&apos;q.</p>
        ) : (
          <ul className="space-y-2">
            {rules.rules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{RULE_KIND_TEXT[rule.kind].title}</p>
                  <p className="break-words text-xs text-muted">{describeRule(rule)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Toggle on={rule.active} label={`${RULE_KIND_TEXT[rule.kind].title} qoidasi faol`} onChange={(on) => void patchRule(rule.id, { active: on })} />
                  <ConfirmButton label="O'chirish" question="Qoida o'chirilsinmi?" confirmLabel="O'chirish" danger onConfirm={() => void deleteRule(rule.id)} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {rules && <NewRuleForm intents={rules.intents} onCreated={() => void load()} />}
      </section>
    </div>
  );
}
