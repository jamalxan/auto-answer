"use client";

/**
 * Test console: runs the saved draft in the sandbox (no Instagram call, no
 * lead, no tag — effects are stubbed) with scripted inputs: contact, typed
 * messages, button taps, 24h window open / closed. Shows the step timeline
 * with the simulated chat, the variables and the policy verdict. A clean run
 * marks the exact version hash as tested (needed before approving an AI
 * version).
 */

import { useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { EmptyState, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import type { FlowGraph } from "@/lib/flows/schema";
import { FLOWS_API, jsonInit, requestJson, valueText } from "./shared";
import { VerdictPill } from "./previews";

interface SandboxStep {
  seq?: number;
  nodeId: string;
  nodeType?: string;
  status?: string;
  reason?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}
interface SandboxSend {
  nodeId: string;
  text: string;
  buttons?: Array<{ id: string; label: string } | string>;
  privateReply?: boolean;
}
interface SandboxView {
  steps: SandboxStep[];
  sends: SandboxSend[];
  status?: string;
  endedAt?: string | null;
  variables?: Record<string, unknown>;
  policyVerdict?: "PASS" | "WARNING" | "BLOCKED";
  warnings?: string[];
  endReason?: string | null;
  effects?: Array<{ kind: string; detail: Record<string, unknown> }>;
  tags?: string[];
}
interface TestResponse {
  result: SandboxView;
  passed: boolean;
  testedAt: string | null;
}

const STEP_TONE: Record<string, "success" | "warning" | "error" | "muted"> = { DONE: "success", WAITING: "warning", FAILED: "error", SKIPPED: "muted" };

function buttonsOf(graph: FlowGraph): Array<{ id: string; label: string; node: string }> {
  const out: Array<{ id: string; label: string; node: string }> = [];
  for (const node of graph.nodes) {
    if (node.type === "message" && node.button) out.push({ id: node.button.id, label: node.button.label, node: node.id });
    if (node.type === "button") for (const b of node.buttons) out.push({ id: b.id, label: b.label, node: node.id });
  }
  return out;
}

export default function TestConsole({
  flowId,
  graph,
  dirty,
  ensureSaved,
  onTested,
  canRun,
}: {
  flowId: string;
  graph: FlowGraph;
  dirty: boolean;
  /** Saves the draft when needed and returns the version id to test (null = failed, the editor shows why). */
  ensureSaved: () => Promise<string | null>;
  onTested: (testedAt: string | null) => void;
  canRun: boolean;
}) {
  const [name, setName] = useState("Ali");
  const [phone, setPhone] = useState("");
  const [windowState, setWindowState] = useState<"open" | "closed">("open");
  const [inbound, setInbound] = useState("");
  const [taps, setTaps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<TestResponse | null>(null);
  const seq = useRef(0);
  const buttons = buttonsOf(graph);
  const label = (id: string) => buttons.find((b) => b.id === id)?.label ?? id;

  function preset() {
    const first = buttons[0];
    setTaps(first ? [first.id] : []);
    setInbound("Narxi qancha?\n+998 90 123 45 67");
    setWindowState("open");
    setPhone("");
  }

  async function run() {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const versionId = await ensureSaved();
      if (!versionId) return;
      const body = {
        contact: { name: name.trim() || undefined, phone: phone.trim() || undefined },
        inbound: inbound
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text) => ({ text })),
        taps,
        window: windowState,
      };
      const res = await requestJson<TestResponse>(`${FLOWS_API}/${flowId}/versions/${versionId}/test`, jsonInit("POST", body));
      if (mine !== seq.current) return;
      if (res.ok) {
        setResponse(res.data);
        if (res.data.passed) onTested(res.data.testedAt);
      } else setError(res.error);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }

  const result = response?.result ?? null;
  const sendQueue = result ? [...result.sends] : [];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section aria-label="Test kirishlari" className="panel space-y-4 rounded-xl p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Kirishlar</h3>
          <button type="button" className={secondaryButton} onClick={preset}>
            Namunaviy ssenariy
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="label-mono text-[11px] font-semibold text-muted">Mijoz ismi</span>
            <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="label-mono text-[11px] font-semibold text-muted">Mijoz telefoni (ixtiyoriy)</span>
            <input className={inputClass} value={phone} maxLength={30} placeholder="+998901234567" onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="label-mono text-[11px] font-semibold text-muted">24 soatlik oyna</span>
          <select className={inputClass} value={windowState} onChange={(e) => setWindowState(e.target.value as "open" | "closed")}>
            <option value="open">Ochiq (mijoz yaqinda yozgan)</option>
            <option value="closed">Yopiq (24 soatdan oshgan)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="label-mono text-[11px] font-semibold text-muted">Mijoz yozadigan xabarlar (har qatorda bittadan)</span>
          <textarea className={`${inputClass} resize-y`} rows={3} value={inbound} onChange={(e) => setInbound(e.target.value)} placeholder={"Narxi qancha?\n+998901234567"} />
        </label>
        <div className="space-y-1.5">
          <span className="label-mono text-[11px] font-semibold text-muted">Mijoz bosadigan tugmalar (ketma-ket)</span>
          {buttons.length === 0 ? (
            <p className="text-xs text-muted">Oqimda tugma yo&apos;q.</p>
          ) : (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Tugma qo'shish">
              {buttons.map((b) => (
                <button key={`${b.node}-${b.id}`} type="button" className="rounded-full border border-border px-2 py-0.5 text-xs text-muted hover:border-accent/40 hover:text-foreground" onClick={() => setTaps((t) => [...t, b.id])}>
                  + {b.label}
                </button>
              ))}
            </div>
          )}
          {taps.length > 0 && (
            <ol className="flex flex-wrap gap-1.5" aria-label="Bosiladigan tugmalar ketma-ketligi">
              {taps.map((id, i) => (
                <li key={i} className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 text-xs text-foreground">
                  {i + 1}. {label(id)}
                  <button type="button" className="text-muted hover:text-foreground" aria-label={`${i + 1}-bosishni olib tashlash`} onClick={() => setTaps((t) => t.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
        <button type="button" className={`${primaryButton} w-full`} disabled={busy || !canRun} onClick={() => void run()}>
          {busy ? "Sinalmoqda…" : dirty ? "Saqlab sinash" : "Sinash"}
        </button>
        {!canRun && <p className="text-xs text-muted">Sinash uchun avval to&apos;g&apos;ri graf kerak.</p>}
        <p className="text-xs text-muted">Sandbox: Instagram&apos;ga hech narsa yuborilmaydi, lead va teg yaratilmaydi.</p>
      </section>

      <section aria-label="Natija" className="min-w-0 space-y-4">
        {error && <Notice tone="error">{error}</Notice>}
        {!result && !error && <EmptyState title="Natija shu yerda ko'rinadi" body="Chapdan kirishlarni tanlab «Sinash» ni bosing." />}
        {result && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={response?.passed ? "success" : "error"}>{response?.passed ? "Muvaffaqiyatli" : "Xato bilan tugadi"}</Pill>
              {result.status && <span className="label-mono text-[11px] text-muted">{result.status}{result.endedAt ? ` · ${result.endedAt}` : ""}</span>}
              {result.policyVerdict && <VerdictPill verdict={result.policyVerdict} />}
              {response?.passed && response.testedAt && <span className="text-xs text-muted">Versiya «sinalgan» deb belgilandi</span>}
            </div>
            {(result.warnings ?? []).length > 0 && (
              <Notice tone="warning">
                <ul className="list-disc space-y-0.5 pl-4">
                  {(result.warnings ?? []).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <ol className="space-y-2" aria-label="Qadamlar">
              {result.steps.length === 0 && <li className="text-sm text-muted">Hech qanday qadam bajarilmadi.</li>}
              {result.steps.map((step, i) => {
                const send = step.status !== "SKIPPED" && step.nodeType && ["message", "button", "ai", "lead", "operator"].includes(step.nodeType) ? sendQueue.find((s) => s.nodeId === step.nodeId) : undefined;
                if (send) sendQueue.splice(sendQueue.indexOf(send), 1);
                return (
                  <li key={`${step.seq ?? i}-${step.nodeId}`} className="rounded-lg border border-border px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="label-mono w-6 text-[10px] text-muted">{i + 1}</span>
                      <span className="font-semibold text-foreground">{step.nodeId}</span>
                      {step.nodeType && <span className="text-xs text-muted">{step.nodeType}</span>}
                      <Pill tone={STEP_TONE[step.status ?? ""] ?? "muted"}>{step.status ?? "—"}</Pill>
                      {step.reason && <span className="min-w-0 break-words text-xs text-muted">{step.reason}</span>}
                    </div>
                    {step.output && Object.keys(step.output).length > 0 && <p className="mt-1 break-words text-xs text-muted">→ {valueText(step.output)}</p>}
                    {send && (
                      <div className="mt-2 max-w-[90%] space-y-1">
                        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-surface-hover px-3 py-2 text-[13px] text-foreground">{send.text}</div>
                        {send.buttons && send.buttons.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {send.buttons.map((b, j) => (
                              <span key={j} className="rounded-full border border-accent/40 px-2.5 py-1 text-[12px] font-medium text-accent">
                                {typeof b === "string" ? b : b.label}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {sendQueue.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted">Yana yuborilgan xabarlar</p>
                {sendQueue.map((s, i) => (
                  <div key={i} className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-surface-hover px-3 py-2 text-[13px] text-foreground">
                    {s.text}
                  </div>
                ))}
              </div>
            )}
            {((result.effects ?? []).length > 0 || (result.tags ?? []).length > 0) && (
              <section aria-label="Haqiqiy ishda nima bo'lardi" className="rounded-xl border border-border p-3">
                <h3 className="mb-2 text-sm font-semibold text-foreground">Haqiqiy ishda nima bo&apos;lardi</h3>
                <ul className="space-y-1 text-sm">
                  {(result.tags ?? []).length > 0 && <li className="text-foreground">Teglar: {(result.tags ?? []).join(", ")}</li>}
                  {(result.effects ?? []).map((e, i) => (
                    <li key={i} className="break-words text-foreground">
                      <span className="label-mono mr-2 text-[10px] text-muted">{e.kind}</span>
                      <span className="text-xs text-muted">{valueText(e.detail)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {result.variables && Object.keys(result.variables).length > 0 && (
              <section aria-label="O'zgaruvchilar" className="rounded-xl border border-border p-3">
                <h3 className="mb-2 text-sm font-semibold text-foreground">O&apos;zgaruvchilar</h3>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                  {Object.entries(result.variables).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="label-mono text-[11px] text-muted">{k}</dt>
                      <dd className="min-w-0 break-words text-foreground">{valueText(v)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
}
