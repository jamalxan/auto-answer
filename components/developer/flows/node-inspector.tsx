"use client";

/**
 * Per-block form of the Flow Builder, shared by the Simple (stacked) editor
 * and the Advanced canvas: one form per node type driven by lib/flows/schema
 * (limits shown), variable chips on every template text, and the outgoing
 * handles of the block with a "→ keyingi blok" target selector.
 */

import { useState } from "react";
import { ChipInput, inputClass, secondaryButton, Toggle } from "@/components/developer/ui";
import { Advanced } from "@/components/developer/comments/parts";
import type { FlowGraph, FlowNode } from "@/lib/flows/schema";
import ConditionBuilder from "./condition-builder";
import { Labeled, NumberInput, SelectInput, TemplateField, TextInput } from "./fields";
import { describeNode, edgeTarget, handlesOf, nodeTitle, shortId, variableChips } from "./graph-edit";
import type { FlowsMeta, MetaAccount } from "./shared";

export interface InspectorProps {
  node: FlowNode;
  graph: FlowGraph;
  meta: FlowsMeta | null;
  account: MetaAccount | null;
  /** `rename` moves edges between handles of this node (message: next <-> tap). */
  onChange: (next: FlowNode, rename?: Record<string, string>) => void;
  onEdge: (handle: string, to: string | null) => void;
  /** The block after this one in list order (Simple mode): its option is labelled "→ keyingi blok". */
  nextInList?: string | null;
  showHandles?: boolean;
}

type Common = {
  graph: FlowGraph;
  meta: FlowsMeta | null;
  account: MetaAccount | null;
  chips: ReturnType<typeof variableChips>;
  declared: string[];
};

const LIMIT_FALLBACK = { messageLength: 1000, buttonTemplateTextLength: 640, buttonLabelLength: 20, quickReplies: 13, publicReplyLength: 300, branches: 8, delayMaxMinutes: 10080 };

function limitsOf(meta: FlowsMeta | null) {
  return meta?.limits ?? { ...LIMIT_FALLBACK, nodes: 120, edges: 300, variables: 50, windowMinutes: 1435 };
}

/**
 * The note under "Tugma qo'shish". "Must have a button" only holds for the FIRST message of a comment /
 * live-comment flow (it goes out as a private reply); Direct / story flows may send plain text.
 */
export function messageButtonHint(graph: FlowGraph, nodeId: string): string {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const commentFlow = trigger?.type === "trigger" && (trigger.triggerType === "COMMENT" || trigger.triggerType === "LIVE_COMMENT");
  if (commentFlow && trigger && edgeTarget(graph, trigger.id, "next") === nodeId) {
    return "Komment oqimida birinchi xabar tugmali bo'lishi shart — mijoz bosgach 24 soatlik oyna ochiladi.";
  }
  return "Ixtiyoriy: mijoz tugmani bosguncha oqim kutadi, bosgach 24 soatlik oyna yangilanadi.";
}

export default function NodeInspector({ node, graph, meta, account, onChange, onEdge, nextInList, showHandles = true }: InspectorProps) {
  const common: Common = {
    graph,
    meta,
    account,
    chips: variableChips(graph, meta),
    declared: graph.variables.map((v) => v.key),
  };
  return (
    <div className="space-y-4">
      <NodeForm node={node} common={common} onChange={onChange} />
      {showHandles && <HandleTargets node={node} graph={graph} onEdge={onEdge} nextInList={nextInList ?? null} />}
    </div>
  );
}

// ─── Handles ──────────────────────────────────────────────────────────────────

export function HandleTargets({ node, graph, onEdge, nextInList }: { node: FlowNode; graph: FlowGraph; onEdge: (handle: string, to: string | null) => void; nextInList: string | null }) {
  const handles = handlesOf(node);
  if (handles.length === 0) {
    return <p className="text-xs text-muted">Bu blokdan keyin hech narsa ulanmaydi — oqim shu yerda tugaydi.</p>;
  }
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="label-mono text-[11px] font-semibold text-muted">Keyingi qadam</p>
      <ul className="space-y-2">
        {handles.map(({ handle, required, label }) => {
          const target = edgeTarget(graph, node.id, handle);
          const missing = required && !target;
          return (
            <li key={handle} className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center">
              <label htmlFor={`h-${node.id}-${handle}`} className={`text-xs ${missing ? "font-semibold text-error" : "text-foreground"}`}>
                ↳ {label}
                {!required && <span className="ml-1 text-muted">(ixtiyoriy)</span>}
              </label>
              <select
                id={`h-${node.id}-${handle}`}
                className={`${inputClass} ${missing ? "border-error/50" : ""}`}
                value={target ?? ""}
                onChange={(e) => onEdge(handle, e.target.value || null)}
              >
                <option value="">{required ? "— ulanmagan (xato) —" : "— ulanmagan —"}</option>
                {graph.nodes
                  .filter((n) => n.id !== node.id && n.type !== "trigger")
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.id === nextInList ? "→ keyingi blok: " : ""}
                      {n.id} · {nodeTitle(n)}: {describeNode(n).slice(0, 40)}
                    </option>
                  ))}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Forms ────────────────────────────────────────────────────────────────────

function NodeForm({ node, common, onChange }: { node: FlowNode; common: Common; onChange: InspectorProps["onChange"] }) {
  switch (node.type) {
    case "trigger":
      return <TriggerForm node={node} common={common} onChange={onChange} />;
    case "message":
      return <MessageForm node={node} common={common} onChange={onChange} />;
    case "button":
      return <ButtonForm node={node} common={common} onChange={onChange} />;
    case "ai":
      return <AiForm node={node} common={common} onChange={onChange} />;
    case "condition":
      return <ConditionForm node={node} common={common} onChange={onChange} />;
    case "delay":
      return <DelayForm node={node} onChange={onChange} />;
    case "tag":
      return <TagForm node={node} common={common} onChange={onChange} />;
    case "lead":
      return <LeadForm node={node} common={common} onChange={onChange} />;
    case "webhook":
      return <WebhookForm node={node} common={common} onChange={onChange} />;
    case "crm":
      return <CrmForm node={node} common={common} onChange={onChange} />;
    case "operator":
      return <OperatorForm node={node} common={common} onChange={onChange} />;
    case "action":
      return <ActionForm node={node} common={common} onChange={onChange} />;
    case "end":
      return <TextInput label="Tugash sababi (ixtiyoriy)" value={node.reason ?? ""} max={80} onChange={(reason) => onChange({ ...node, reason: reason || undefined })} />;
  }
}

type P<T extends FlowNode["type"]> = { node: Extract<FlowNode, { type: T }>; common: Common; onChange: InspectorProps["onChange"] };

function TriggerForm({ node, common, onChange }: P<"trigger">) {
  const { meta } = common;
  const comment = node.triggerType === "COMMENT" || node.triggerType === "LIVE_COMMENT";
  const set = (patch: Partial<typeof node>) => onChange({ ...node, ...patch });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectInput
          label="Qachon ishga tushadi"
          value={node.triggerType}
          onChange={(triggerType) => set({ triggerType })}
          options={[
            { value: "COMMENT", label: "Postga komment" },
            { value: "LIVE_COMMENT", label: "Live'ga komment" },
            { value: "DIRECT_MESSAGE", label: "Direct xabar" },
            { value: "STORY_MENTION", label: "Story'da belgilash" },
          ]}
        />
        <SelectInput
          label="Mos kelish"
          value={node.matchingMode}
          onChange={(matchingMode) => set({ matchingMode })}
          options={[
            { value: "CONTAINS", label: "Kalit so'z bor" },
            { value: "EXACT", label: "Aniq mos" },
            { value: "EVERY", label: "Har bir xabar / komment" },
          ]}
        />
      </div>
      {node.matchingMode !== "EVERY" && (
        <>
          <Labeled label="Kalit so'zlar" hint="Enter yoki vergul bilan qo'shing">
            <ChipInput values={node.keywords} onChange={(keywords) => set({ keywords })} placeholder="narx, qancha, price" max={50} />
          </Labeled>
          {meta && meta.intents.length > 0 && (
            <div className="space-y-1.5">
              <span className="label-mono text-[11px] font-semibold text-muted">Yoki niyat bo&apos;yicha</span>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Niyatlar">
                {meta.intents.map((intent) => {
                  const on = node.intents.includes(intent.key);
                  return (
                    <button
                      key={intent.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ intents: on ? node.intents.filter((k) => k !== intent.key) : [...node.intents, intent.key] })}
                      className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted"}`}
                    >
                      {intent.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
      {comment && (
        <TemplateField
          label="Komment ostiga ochiq javob"
          optional
          rows={2}
          value={node.publicReply ?? ""}
          max={limitsOf(meta).publicReplyLength}
          chips={common.chips.slice(0, 2)}
          declared={common.declared}
          onChange={(v) => set({ publicReply: v || undefined })}
          hint={node.triggerType === "LIVE_COMMENT" ? "Live kommentda ochiq javob yuborilmaydi" : undefined}
        />
      )}
      <Advanced label="Qo'shimcha sozlamalar">
        <div className="grid gap-3 sm:grid-cols-2">
          {comment && (
            <SelectInput label="Postlar" value={node.mediaScope} onChange={(mediaScope) => set({ mediaScope })} options={[{ value: "ANY", label: "Hamma postlar" }, { value: "SPECIFIC", label: "Tanlangan postlar" }]} />
          )}
          {node.triggerType === "STORY_MENTION" && (
            <SelectInput label="Story'lar" value={node.storyScope} onChange={(storyScope) => set({ storyScope })} options={[{ value: "ALL", label: "Hammasi" }, { value: "SPECIFIC", label: "Tanlanganlar" }]} />
          )}
          <SelectInput
            label="Kim uchun"
            value={node.audience}
            onChange={(audience) => set({ audience })}
            options={[
              { value: "ANY", label: "Hamma" },
              { value: "NEW_CONTACT", label: "Yangi kontakt" },
              { value: "RETURNING_CONTACT", label: "Qaytgan kontakt" },
              { value: "REOPENED", label: "Uzoq jimdan keyin qaytgan" },
            ]}
          />
          {node.triggerType === "DIRECT_MESSAGE" && (
            <SelectInput label="Manba" value={node.sourceFilter} onChange={(sourceFilter) => set({ sourceFilter })} options={[{ value: "ANY", label: "Hammasi" }, { value: "ADS", label: "Reklama" }, { value: "LINK", label: "ig.me havola" }]} />
          )}
          <NumberInput label="Takror ishlash oralig'i" unit="soat" min={0} max={720} value={node.cooldownHours} onChange={(v) => set({ cooldownHours: v ?? 0 })} hint="0 = har safar" />
          <NumberInput label="Ustuvorlik" min={-100} max={100} value={node.priority} onChange={(v) => set({ priority: v ?? 0 })} hint="Katta son — oldin tekshiriladi" />
        </div>
        {comment && node.mediaScope === "SPECIFIC" && (
          <Labeled label="Post identifikatorlari">
            <ChipInput values={node.mediaIds} onChange={(mediaIds) => set({ mediaIds })} placeholder="media id" max={20} />
          </Labeled>
        )}
        {node.storyScope === "SPECIFIC" && (
          <Labeled label="Story identifikatorlari">
            <ChipInput values={node.storyIds} onChange={(storyIds) => set({ storyIds })} placeholder="story id" max={50} />
          </Labeled>
        )}
      </Advanced>
    </div>
  );
}

function MessageForm({ node, common, onChange }: P<"message">) {
  const lim = limitsOf(common.meta);
  const hasButton = !!node.button;
  const hint = messageButtonHint(common.graph, node.id);
  return (
    <div className="space-y-3">
      <TemplateField
        label="Xabar matni"
        value={node.text}
        max={hasButton ? lim.buttonTemplateTextLength : lim.messageLength}
        chips={common.chips}
        declared={common.declared}
        onChange={(text) => onChange({ ...node, text })}
      />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div>
          <p className="text-sm font-medium text-foreground">Tugma qo&apos;shish</p>
          <p className="text-xs text-muted">{hint}</p>
        </div>
        <Toggle
          label="Tugma qo'shish"
          on={hasButton}
          onChange={(on) => {
            if (on) onChange({ ...node, text: node.text.slice(0, lim.buttonTemplateTextLength), button: { id: shortId("b"), label: "Davom etish" } }, { next: "tap" });
            else onChange({ ...node, button: undefined }, { tap: "next" });
          }}
        />
      </div>
      {node.button && (
        <TextInput
          label={`Tugma yozuvi (${node.button.label.length}/${lim.buttonLabelLength})`}
          value={node.button.label}
          max={lim.buttonLabelLength}
          onChange={(label) => onChange({ ...node, button: { id: node.button!.id, label } })}
        />
      )}
      <Advanced>
        <NumberInput label="Yozish animatsiyasi" unit="ms" min={0} max={5000} value={node.typingDelayMs} onChange={(v) => onChange({ ...node, typingDelayMs: v ?? 0 })} />
      </Advanced>
    </div>
  );
}

function ButtonForm({ node, common, onChange }: P<"button">) {
  const lim = limitsOf(common.meta);
  const setButton = (index: number, patch: Partial<(typeof node.buttons)[number]>) =>
    onChange({ ...node, buttons: node.buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)) });
  return (
    <div className="space-y-3">
      <TemplateField label="Matn" value={node.text} max={lim.messageLength} chips={common.chips} declared={common.declared} onChange={(text) => onChange({ ...node, text })} />
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="label-mono text-[11px] font-semibold text-muted">
            Tugmalar ({node.buttons.length}/{lim.quickReplies})
          </span>
          <button
            type="button"
            className={secondaryButton}
            disabled={node.buttons.length >= lim.quickReplies}
            onClick={() => onChange({ ...node, buttons: [...node.buttons, { id: shortId("b"), label: `Variant ${node.buttons.length + 1}`, kind: "text" }] })}
          >
            + Tugma
          </button>
        </div>
        {node.buttons.map((b, i) => (
          <div key={b.id} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <TextInput label={`${i + 1}-tugma (${b.label.length}/${lim.buttonLabelLength})`} value={b.label} max={lim.buttonLabelLength} onChange={(label) => setButton(i, { label })} />
            <SelectInput
              label="Turi"
              value={b.kind}
              onChange={(kind) => setButton(i, { kind, saveAs: kind === "phone" && !b.saveAs ? "phone" : kind === "email" && !b.saveAs ? "email" : b.saveAs })}
              options={[
                { value: "text", label: "Oddiy" },
                { value: "phone", label: "Telefon so'rash" },
                { value: "email", label: "Email so'rash" },
              ]}
            />
            <TextInput label="Saqlash: vars." value={b.saveAs ?? ""} max={32} placeholder="phone" onChange={(v) => setButton(i, { saveAs: v.replace(/[^a-z0-9_]/g, "") || undefined })} />
            <button type="button" className={secondaryButton} disabled={node.buttons.length <= 1} aria-label={`${i + 1}-tugmani o'chirish`} onClick={() => onChange({ ...node, buttons: node.buttons.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
      </div>
      <SelectInput
        label="Mijoz tugma o'rniga yozsa"
        value={node.onText}
        onChange={(onText) => onChange({ ...node, onText })}
        options={[
          { value: "other_edge", label: "«Boshqa narsa yozsa» yo'liga o'tish" },
          { value: "keep_waiting", label: "Tugma bosilishini kutishda davom etish" },
        ]}
      />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div>
          <p className="text-sm font-medium text-foreground">Javob bo&apos;lmasa, davom etish</p>
          <p className="text-xs text-muted">Belgilangan vaqtdan keyin «vaqt tugadi» yo&apos;liga o&apos;tadi (24 soatlik oyna hisobga olinadi).</p>
        </div>
        <Toggle label="Vaqt tugash yo'li" on={!!node.timeoutMinutes} onChange={(on) => onChange({ ...node, timeoutMinutes: on ? 60 : undefined })} />
      </div>
      {node.timeoutMinutes !== undefined && <Duration label="Kutish" minutes={node.timeoutMinutes} max={lim.delayMaxMinutes} onChange={(m) => onChange({ ...node, timeoutMinutes: m })} />}
    </div>
  );
}

function AiForm({ node, common, onChange }: P<"ai">) {
  const lim = limitsOf(common.meta);
  return (
    <div className="space-y-3">
      <SelectInput
        label="JavobAI nima qiladi"
        value={node.mode}
        onChange={(mode) => onChange({ ...node, mode })}
        options={[
          { value: "takeover", label: "Suhbatni to'liq o'ziga oladi" },
          { value: "ask", label: "Savol beradi va javobdan ma'lumot oladi" },
        ]}
      />
      {node.mode === "takeover" ? (
        <>
          <TemplateField label="Kirish xabari" optional rows={2} value={node.intro ?? ""} max={lim.messageLength} chips={common.chips} declared={common.declared} onChange={(v) => onChange({ ...node, intro: v || undefined })} />
          {common.account && common.account.javobAiMode !== "LIVE" && (
            <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              Bu akkauntda JavobAI hozir {common.account.javobAiMode === "SHADOW" ? "SHADOW" : "o'chiq"} — suhbat JavobAI ga o&apos;tmaydi. «JavobAI yoqilmagan bo&apos;lsa» yo&apos;lini operatorga ulang.
            </p>
          )}
        </>
      ) : (
        <>
          <TemplateField label="Savol" rows={2} value={node.question ?? ""} max={lim.messageLength} chips={common.chips} declared={common.declared} onChange={(v) => onChange({ ...node, question: v || undefined })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput label="Saqlash: vars." value={node.saveAs ?? ""} max={32} placeholder="phone" onChange={(v) => onChange({ ...node, saveAs: v.replace(/[^a-z0-9_]/g, "") || undefined })} />
            <SelectInput
              label="Nimani ajratib oladi"
              value={node.extract ?? "free_text"}
              onChange={(extract) => onChange({ ...node, extract })}
              options={[
                { value: "phone", label: "Telefon" },
                { value: "email", label: "Email" },
                { value: "name", label: "Ism" },
                { value: "city", label: "Shahar" },
                { value: "product", label: "Mahsulot" },
                { value: "yes_no", label: "Ha / yo'q" },
                { value: "number", label: "Raqam" },
                { value: "free_text", label: "Erkin matn" },
              ]}
            />
            <NumberInput label="Qayta so'rash" min={0} max={2} value={node.retries} onChange={(v) => onChange({ ...node, retries: v ?? 0 })} />
          </div>
          {node.retries > 0 && (
            <TemplateField label="Qayta so'rash matni" optional rows={2} value={node.retryText ?? ""} max={lim.messageLength} chips={common.chips} declared={common.declared} onChange={(v) => onChange({ ...node, retryText: v || undefined })} />
          )}
        </>
      )}
    </div>
  );
}

function ConditionForm({ node, common, onChange }: P<"condition">) {
  const lim = limitsOf(common.meta);
  const setBranch = (index: number, patch: Partial<(typeof node.branches)[number]>) => onChange({ ...node, branches: node.branches.map((b, i) => (i === index ? { ...b, ...patch } : b)) });
  return (
    <div className="space-y-3">
      {node.branches.map((branch, i) => (
        <div key={branch.id} className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextInput label={`${i + 1}-tarmoq nomi`} value={branch.label} max={40} onChange={(label) => setBranch(i, { label })} />
            </div>
            <button type="button" className={secondaryButton} disabled={node.branches.length <= 1} aria-label={`${i + 1}-tarmoqni o'chirish`} onClick={() => onChange({ ...node, branches: node.branches.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
          <ConditionBuilder meta={common.meta} graphVars={common.declared} value={branch.when} onChange={(when) => setBranch(i, { when })} />
        </div>
      ))}
      <button
        type="button"
        className={secondaryButton}
        disabled={node.branches.length >= lim.branches}
        onClick={() => onChange({ ...node, branches: [...node.branches, { id: shortId("c"), label: `Shart ${node.branches.length + 1}`, when: { v: 1, all: [] } }] })}
      >
        + Tarmoq qo&apos;shish ({node.branches.length}/{lim.branches})
      </button>
      <p className="text-xs text-muted">Tarmoqlar yuqoridan pastga tekshiriladi; birinchi mos kelgani tanlanadi. Hech biri mos kelmasa — «hech biri» yo&apos;li.</p>
    </div>
  );
}

function Duration({ label, minutes, max, onChange }: { label: string; minutes: number; max: number; onChange: (minutes: number) => void }) {
  const initial = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
  const [unit, setUnit] = useState<1 | 60 | 1440>(initial as 1 | 60 | 1440);
  const amount = Math.max(1, Math.round(minutes / unit));
  const set = (a: number, u: number) => onChange(Math.min(max, Math.max(1, a * u)));
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <NumberInput label={label} min={1} value={amount} onChange={(v) => set(v ?? 1, unit)} />
      <SelectInput
        label="Birlik"
        value={String(unit) as "1" | "60" | "1440"}
        onChange={(u) => {
          const next = Number(u) as 1 | 60 | 1440;
          setUnit(next);
          set(amount, next);
        }}
        options={[
          { value: "1", label: "daqiqa" },
          { value: "60", label: "soat" },
          { value: "1440", label: "kun" },
        ]}
      />
    </div>
  );
}

function DelayForm({ node, onChange }: { node: Extract<FlowNode, { type: "delay" }>; onChange: InspectorProps["onChange"] }) {
  return (
    <div className="space-y-3">
      <Duration label="Kutish" minutes={node.minutes} max={7 * 24 * 60} onChange={(minutes) => onChange({ ...node, minutes })} />
      {node.minutes >= 24 * 60 - 5 && <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">24 soatdan uzoq kutilsa, Instagram oynasi yopiladi: keyingi xabar faqat mijoz yozsa ketadi.</p>}
      <SelectInput
        label="Kutish tugaganda oyna yopiq bo'lsa"
        value={node.ifWindowClosed}
        onChange={(ifWindowClosed) => onChange({ ...node, ifWindowClosed })}
        options={[
          { value: "end", label: "Oqim tugaydi (tavsiya)" },
          { value: "skip_sends", label: "Xabarlarni o'tkazib, davom etadi" },
          { value: "wait_for_inbound", label: "Mijoz yozishini kutadi" },
        ]}
      />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div>
          <p className="text-sm font-medium text-foreground">Mijoz yozsa, bekor qilish</p>
          <p className="text-xs text-muted">Kutish paytida javob kelsa, keyingi xabarlar yuborilmaydi.</p>
        </div>
        <Toggle label="Javob bo'lsa bekor qilish" on={node.cancelOnReply} onChange={(cancelOnReply) => onChange({ ...node, cancelOnReply })} />
      </div>
    </div>
  );
}

function TagForm({ node, common, onChange }: P<"tag">) {
  const known = common.meta?.tags ?? [];
  return (
    <div className="space-y-3">
      <SelectInput label="Amal" value={node.action} onChange={(action) => onChange({ ...node, action })} options={[{ value: "add", label: "Teg qo'shish" }, { value: "remove", label: "Tegni olib tashlash" }]} />
      {known.length > 0 && (
        <div className="space-y-1.5">
          <span className="label-mono text-[11px] font-semibold text-muted">Mavjud teglar</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Teglar">
            {known.map((t) => {
              const on = node.tagSlugs.includes(t.slug);
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange({ ...node, tagSlugs: on ? node.tagSlugs.filter((s) => s !== t.slug) : [...node.tagSlugs, t.slug] })}
                  className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted"}`}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <Labeled label="Teg (slug)" hint="Yangi teg yozsangiz, audit uni «mavjud emas» deb belgilaydi — avval CRM'da yarating.">
        <ChipInput values={node.tagSlugs} onChange={(tagSlugs) => onChange({ ...node, tagSlugs: tagSlugs.length ? tagSlugs : node.tagSlugs })} placeholder="hot" max={10} />
      </Labeled>
    </div>
  );
}

function LeadForm({ node, common, onChange }: P<"lead">) {
  const lim = limitsOf(common.meta);
  return (
    <div className="space-y-3">
      <Labeled label="Telefon qayerdan olinadi" hint="Masalan vars.phone — «Telefon so'rash» tugmasi yoki savol blokida saqlangan.">
        <input className={inputClass} list={`lead-phone-${node.id}`} value={node.phoneFrom} maxLength={40} onChange={(e) => onChange({ ...node, phoneFrom: e.target.value || "vars.phone" })} />
        <datalist id={`lead-phone-${node.id}`}>
          <option value="contact.phone" />
          {common.declared.map((k) => (
            <option key={k} value={`vars.${k}`} />
          ))}
        </datalist>
      </Labeled>
      <TemplateField label="Lead izohi" optional rows={2} value={node.summary ?? ""} max={300} chips={common.chips} declared={common.declared} onChange={(v) => onChange({ ...node, summary: v || undefined })} />
      <TemplateField label="Mijozga rahmat xabari" optional rows={2} value={node.thanks ?? ""} max={lim.messageLength} chips={common.chips} declared={common.declared} onChange={(v) => onChange({ ...node, thanks: v || undefined })} />
    </div>
  );
}

function WebhookForm({ node, common, onChange }: P<"webhook">) {
  const entries = Object.entries(node.body);
  const setBody = (next: Array<[string, string]>) => onChange({ ...node, body: Object.fromEntries(next) });
  const notHttps = node.url !== "" && !/^https:\/\//i.test(node.url);
  return (
    <div className="space-y-3">
      <TextInput label="Manzil (https)" value={node.url} max={500} placeholder="https://hooks.example.com/lead" onChange={(url) => onChange({ ...node, url })} />
      {notHttps && <p className="text-xs text-error">Faqat https manzillar ruxsat etiladi; ichki (localhost, 10.x, 192.168.x) manzillar rad etiladi.</p>}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="label-mono text-[11px] font-semibold text-muted">So&apos;rov tanasi (JSON maydonlari)</span>
          <button type="button" className={secondaryButton} disabled={entries.length >= 20} onClick={() => setBody([...entries, [`maydon${entries.length + 1}`, "{{name}}"]])}>
            + Maydon
          </button>
        </div>
        {entries.map(([key, value], i) => (
          <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] sm:items-end">
            <TextInput label="Kalit" value={key} max={64} onChange={(k) => setBody(entries.map((e, j) => (j === i ? [k, e[1]] : e)))} />
            <TextInput label="Qiymat (shablon)" value={value} max={500} onChange={(v) => setBody(entries.map((e, j) => (j === i ? [e[0], v] : e)))} />
            <button type="button" className={secondaryButton} aria-label={`${i + 1}-maydonni o'chirish`} onClick={() => setBody(entries.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <p className="text-xs text-muted">Qiymatlarda {"{{name}}"}, {"{{phone}}"}, {"{{vars.x}}"} ishlatish mumkin.</p>
      </div>
      <Advanced>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextInput label="Javobni saqlash: vars." value={node.saveAs ?? ""} max={32} onChange={(v) => onChange({ ...node, saveAs: v.replace(/[^a-z0-9_]/g, "") || undefined })} />
          <TextInput label="Javobdagi yo'l (JSON path)" value={node.savePath ?? ""} max={100} placeholder="data.id" onChange={(v) => onChange({ ...node, savePath: v || undefined })} />
          <NumberInput label="Kutish chegarasi" unit="ms" min={1000} max={10000} value={node.timeoutMs} onChange={(v) => onChange({ ...node, timeoutMs: v ?? 5000 })} />
        </div>
      </Advanced>
    </div>
  );
}

function CrmForm({ node, common, onChange }: P<"crm">) {
  const pipelines = common.meta?.pipelines ?? [];
  const stages = pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p })));
  const members = common.meta?.members ?? [];
  return (
    <div className="space-y-3">
      <SelectInput
        label="Amal"
        value={node.action}
        onChange={(action) => onChange({ ...node, action })}
        options={[
          { value: "move_stage", label: "Bosqichga o'tkazish" },
          { value: "create_deal", label: "Bitim yaratish" },
          { value: "assign", label: "Operatorga biriktirish" },
          { value: "set_field", label: "Maydon qiymatini yozish" },
        ]}
      />
      {(node.action === "move_stage" || node.action === "create_deal") && (
        <Labeled label="Bosqich">
          <select
            className={inputClass}
            value={node.stageId ?? ""}
            onChange={(e) => {
              const stage = stages.find((s) => s.id === e.target.value);
              onChange({ ...node, stageId: e.target.value || undefined, pipelineId: stage?.pipeline.id });
            }}
          >
            <option value="">{node.action === "create_deal" ? "Kirish bosqichi (standart)" : "Tanlang…"}</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.pipeline.name} · {s.name}
              </option>
            ))}
          </select>
        </Labeled>
      )}
      {node.action === "assign" && (
        <>
          <SelectInput label="Qanday" value={node.assignStrategy ?? "rules"} onChange={(assignStrategy) => onChange({ ...node, assignStrategy })} options={[{ value: "rules", label: "Biriktirish qoidalari bo'yicha" }, { value: "member", label: "Aniq a'zoga" }]} />
          {node.assignStrategy === "member" && (
            <Labeled label="A'zo">
              <select className={inputClass} value={node.memberId ?? ""} onChange={(e) => onChange({ ...node, memberId: e.target.value || undefined })}>
                <option value="">Tanlang…</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Labeled>
          )}
        </>
      )}
      {node.action === "set_field" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Maydon" value={node.field ?? ""} max={32} placeholder="city" onChange={(field) => onChange({ ...node, field: field || undefined })} />
          <TextInput label="Qiymat" value={node.value ?? ""} max={200} onChange={(value) => onChange({ ...node, value: value || undefined })} />
        </div>
      )}
    </div>
  );
}

function OperatorForm({ node, common, onChange }: P<"operator">) {
  const lim = limitsOf(common.meta);
  return (
    <div className="space-y-3">
      <TemplateField label="Mijozga xabar" optional rows={2} value={node.reply ?? ""} max={lim.messageLength} chips={common.chips} declared={common.declared} onChange={(v) => onChange({ ...node, reply: v || undefined })} />
      <TemplateField label="Operator uchun izoh" optional rows={2} value={node.note ?? ""} max={300} chips={common.chips} declared={common.declared} onChange={(v) => onChange({ ...node, note: v || undefined })} />
      <SelectInput
        label="Sabab"
        value={node.reason}
        onChange={(reason) => onChange({ ...node, reason })}
        options={[
          { value: "flow_rule", label: "Oqim qoidasi" },
          { value: "wants_human", label: "Odam bilan gaplashmoqchi" },
          { value: "complaint", label: "Shikoyat" },
          { value: "purchase_ready", label: "Sotib olishga tayyor" },
        ]}
      />
    </div>
  );
}

function ActionForm({ node, common, onChange }: P<"action">) {
  const lim = limitsOf(common.meta);
  return (
    <div className="space-y-3">
      <SelectInput
        label="Amal"
        value={node.action}
        onChange={(action) => onChange({ ...node, action })}
        options={[
          { value: "set_variable", label: "O'zgaruvchiga qiymat yozish" },
          { value: "increment", label: "Hisoblagichni oshirish" },
          { value: "notify_telegram", label: "Telegram'ga xabar" },
          { value: "opt_out", label: "Obunadan chiqarish" },
          { value: "stop_followups", label: "Follow-up'larni to'xtatish" },
          { value: "mark_test", label: "Test deb belgilash" },
        ]}
      />
      {(node.action === "set_variable" || node.action === "increment") && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="O'zgaruvchi: vars." value={node.key ?? ""} max={32} onChange={(v) => onChange({ ...node, key: v.replace(/[^a-z0-9_]/g, "") || undefined })} />
          {node.action === "set_variable" && <TextInput label="Qiymat" value={node.value ?? ""} max={500} onChange={(value) => onChange({ ...node, value: value || undefined })} />}
        </div>
      )}
      {node.action === "notify_telegram" && (
        <TemplateField label="Telegram xabari" rows={2} value={node.text ?? ""} max={lim.messageLength} chips={common.chips} declared={common.declared} onChange={(v) => onChange({ ...node, text: v || undefined })} />
      )}
    </div>
  );
}
