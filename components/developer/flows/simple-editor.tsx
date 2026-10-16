"use client";

/**
 * Simple Mode: the graph as vertical stacked blocks (analysis §3.1). Each
 * block is a card (collapsed summary, expanded form); branches and handles
 * show as indented sub-lists with a "→ keyingi blok" selector; a phone-style
 * preview follows the main path. It edits the SAME graph as the canvas.
 */

import { useEffect, useRef, useState } from "react";
import { ConfirmButton } from "@/components/developer/comments/parts";
import { Pill, secondaryButton } from "@/components/developer/ui";
import type { FlowGraph, FlowNode, FlowNodeType } from "@/lib/flows/schema";
import { ADDABLE_TYPES, defaultNode, describeNode, edgeTarget, handlesOf, insertNode, moveNode, newNodeId, NODE_HINTS, nodeTitle, removeNode, setEdge, updateNode } from "./graph-edit";
import NodeInspector from "./node-inspector";
import { PhonePreview } from "./previews";
import type { FlowsMeta, MetaAccount } from "./shared";

const TYPE_TONE: Partial<Record<FlowNodeType, "success" | "warning" | "error" | "muted">> = {
  trigger: "success",
  end: "muted",
  operator: "warning",
  ai: "warning",
};

function AddBlock({ meta, onPick, disabled, atEnd }: { meta: FlowsMeta | null; onPick: (type: FlowNodeType) => void; disabled?: boolean; atEnd?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-center">
      <span aria-hidden="true" className="h-3 w-px bg-border-hover" />
      {open ? (
        <div className="panel w-full rounded-xl p-3" role="group" aria-label="Blok turini tanlang">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-foreground">Qaysi blok?</p>
            <button type="button" className="text-xs text-muted hover:text-foreground" onClick={() => setOpen(false)}>
              Yopish
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ADDABLE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(type);
                }}
                className="rounded-lg border border-border px-3 py-2 text-left hover:border-accent/40"
              >
                <span className="block text-sm font-semibold text-foreground">{meta?.nodeLabels[type] ?? type}</span>
                <span className="block text-xs text-muted">{NODE_HINTS[type]}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <button type="button" className={secondaryButton} disabled={disabled} onClick={() => setOpen(true)} aria-label={atEnd ? "Oxiriga blok qo'shish" : "Shu yerga blok qo'shish"}>
          + Blok{atEnd ? " qo'shish" : ""}
        </button>
      )}
    </div>
  );
}

export default function SimpleEditor({
  graph,
  onChange,
  meta,
  account,
  focusId,
  focusTick,
  readOnly,
}: {
  graph: FlowGraph;
  onChange: (next: FlowGraph) => void;
  meta: FlowsMeta | null;
  account: MetaAccount | null;
  focusId?: string | null;
  /** Bumped by the audit panel so clicking the same finding twice re-focuses. */
  focusTick?: number;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(graph.nodes[1]?.id ?? graph.nodes[0]?.id ?? null);
  const refs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!focusId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- focus request from the audit panel
    setOpen(focusId);
    requestAnimationFrame(() => refs.current.get(focusId)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [focusId, focusTick]);

  const maxNodes = meta?.limits.nodes ?? 120;

  function add(afterId: string | null, type: FlowNodeType) {
    if (graph.nodes.length >= maxNodes) return;
    const node = defaultNode(type, newNodeId(graph, type), meta);
    onChange(insertNode(graph, afterId, node));
    setOpen(node.id);
  }

  function patch(node: FlowNode, next: FlowNode, rename?: Record<string, string>) {
    onChange(updateNode(graph, node.id, next, rename));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0">
        <ol className="space-y-0">
          {graph.nodes.map((node, index) => {
            const expanded = open === node.id;
            const nextId = graph.nodes[index + 1]?.id ?? null;
            const handles = handlesOf(node);
            const missing = handles.filter((h) => h.required && !edgeTarget(graph, node.id, h.handle)).length;
            return (
              <li key={node.id} className="flex flex-col">
                <article
                  ref={(el) => {
                    if (el) refs.current.set(node.id, el);
                    else refs.current.delete(node.id);
                  }}
                  aria-label={`${index + 1}-blok: ${nodeTitle(node)}`}
                  className={`panel rounded-xl ${expanded ? "ring-1 ring-accent/40" : ""}`}
                >
                  <div className="flex items-start gap-2 p-3">
                    <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : node.id)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-bold text-accent">{index + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">{nodeTitle(node)}</span>
                          <span className="label-mono text-[10px] text-muted">{node.id}</span>
                          {TYPE_TONE[node.type] && node.type !== "trigger" && <Pill tone={TYPE_TONE[node.type]!}>{nodeTitle(node)}</Pill>}
                          {missing > 0 && <Pill tone="error">{missing} ta ulanmagan</Pill>}
                        </span>
                        {!expanded && <span className="mt-0.5 block break-words text-sm text-muted">{describeNode(node, meta)}</span>}
                      </span>
                      <span aria-hidden="true" className={`mt-1 text-muted transition-transform ${expanded ? "rotate-180" : ""}`}>
                        ▾
                      </span>
                    </button>
                    {!readOnly && node.type !== "trigger" && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" className={secondaryButton} disabled={index <= 1} onClick={() => onChange(moveNode(graph, node.id, -1))} aria-label={`${node.id} blokni yuqoriga`}>
                          ↑
                        </button>
                        <button type="button" className={secondaryButton} disabled={index >= graph.nodes.length - 1} onClick={() => onChange(moveNode(graph, node.id, 1))} aria-label={`${node.id} blokni pastga`}>
                          ↓
                        </button>
                        <ConfirmButton
                          label="×"
                          question={`«${node.id}» o'chirilsinmi?`}
                          confirmLabel="O'chirish"
                          danger
                          onConfirm={() => {
                            onChange(removeNode(graph, node.id));
                            if (open === node.id) setOpen(null);
                          }}
                        />
                      </div>
                    )}
                  </div>
                  {!expanded && handles.length > 0 && (
                    <ul className="space-y-0.5 border-t border-border px-3 py-2 pl-12">
                      {handles.map(({ handle, label, required }) => {
                        const to = edgeTarget(graph, node.id, handle);
                        if (!to && !required) return null;
                        return (
                          <li key={handle} className="text-xs text-muted">
                            ↳ {label}:{" "}
                            {to ? <span className="text-foreground">{to === nextId ? "→ keyingi blok" : to}</span> : <span className="text-error">ulanmagan</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {expanded && (
                    <fieldset disabled={readOnly} className="min-w-0 border-t border-border p-3 sm:p-4">
                      <legend className="sr-only">{nodeTitle(node)} sozlamalari</legend>
                      <NodeInspector
                        node={node}
                        graph={graph}
                        meta={meta}
                        account={account}
                        nextInList={nextId}
                        onChange={(next, rename) => patch(node, next, rename)}
                        onEdge={(handle, to) => onChange(setEdge(graph, node.id, handle, to))}
                      />
                    </fieldset>
                  )}
                </article>
                {!readOnly && index < graph.nodes.length - 1 && <AddBlock meta={meta} onPick={(type) => add(node.id, type)} disabled={graph.nodes.length >= maxNodes} />}
                {index < graph.nodes.length - 1 && readOnly && <span aria-hidden="true" className="mx-auto h-3 w-px bg-border-hover" />}
              </li>
            );
          })}
        </ol>
        {!readOnly && <AddBlock atEnd meta={meta} onPick={(type) => add(null, type)} disabled={graph.nodes.length >= maxNodes} />}
        <p className="mt-3 text-center text-xs text-muted">
          {graph.nodes.length}/{maxNodes} blok
        </p>
      </div>
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <PhonePreview graph={graph} highlightId={open} />
      </aside>
    </div>
  );
}
