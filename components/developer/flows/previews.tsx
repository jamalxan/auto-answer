"use client";

/**
 * Read-only views of a graph: a phone-style chat preview (sample values for
 * the variables) and a block outline (the stacked-blocks list without forms).
 */

import { Pill } from "@/components/developer/ui";
import type { FlowGraph } from "@/lib/flows/schema";
import { describeNode, edgeTarget, handlesOf, nodeTitle, previewWalk } from "./graph-edit";
import type { FlowsMeta } from "./shared";

export function PhonePreview({ graph, highlightId }: { graph: FlowGraph; highlightId?: string | null }) {
  const bubbles = previewWalk(graph);
  return (
    <div className="mx-auto w-full max-w-[19rem] rounded-[1.75rem] border border-border-hover bg-background p-2 shadow-lg" aria-label="Telefon ko'rinishi">
      <div className="rounded-[1.4rem] bg-surface p-3">
        <p className="mb-3 text-center text-[11px] text-muted">Mijoz ko&apos;radi (namuna qiymatlar bilan)</p>
        <div className="flex min-h-48 flex-col gap-2">
          {bubbles.length === 0 && <p className="py-8 text-center text-xs text-muted">Hali xabar yo&apos;q</p>}
          {bubbles.map((b, i) =>
            b.kind === "note" ? (
              <p key={`${b.nodeId}-${i}`} className="mx-auto rounded-full bg-surface-hover px-3 py-1 text-[11px] text-muted">
                {b.text}
              </p>
            ) : (
              <div key={`${b.nodeId}-${i}`} className="max-w-[88%] space-y-1">
                <div className={`whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-surface-hover px-3 py-2 text-[13px] text-foreground ${highlightId === b.nodeId ? "ring-2 ring-accent" : ""}`}>
                  {b.text || "…"}
                </div>
                {b.buttons.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {b.buttons.map((label) => (
                      <span key={label} className="rounded-full border border-accent/40 px-2.5 py-1 text-[12px] font-medium text-accent">
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** Numbered list of blocks with their outgoing connections (no forms). */
export function BlockOutline({ graph, meta }: { graph: FlowGraph; meta: FlowsMeta | null }) {
  return (
    <ol className="space-y-2">
      {graph.nodes.map((node, i) => (
        <li key={node.id} className="rounded-lg border border-border bg-surface px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">{i + 1}</span>
            <span className="text-sm font-semibold text-foreground">{nodeTitle(node)}</span>
            <span className="label-mono text-[10px] text-muted">{node.id}</span>
          </div>
          <p className="mt-1 break-words text-sm text-muted">{describeNode(node, meta)}</p>
          {handlesOf(node).length > 0 && (
            <ul className="mt-1.5 space-y-0.5 border-l border-border pl-3">
              {handlesOf(node).map(({ handle, label, required }) => {
                const to = edgeTarget(graph, node.id, handle);
                return (
                  <li key={handle} className="text-xs text-muted">
                    ↳ {label}: {to ? <span className="text-foreground">{to}</span> : required ? <span className="text-error">ulanmagan</span> : "—"}
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

export function VerdictPill({ verdict }: { verdict: "PASS" | "WARNING" | "BLOCKED" | null | undefined }) {
  if (!verdict) return <Pill tone="muted">—</Pill>;
  return <Pill tone={verdict === "PASS" ? "success" : verdict === "WARNING" ? "warning" : "error"}>{verdict}</Pill>;
}
