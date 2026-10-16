"use client";

/**
 * Advanced Mode: the SAME graph as the stacked editor on a canvas. No
 * dependency: absolutely positioned cards in a CSS-transformed layer, edges
 * in one SVG overlay (cubic Béziers), native pointer events for dragging
 * nodes and panning, wheel / buttons for zoom.
 *
 *   - drag a card by its header; positions persist in graph.layout
 *   - connect: click a handle dot (right side of a card), then click the
 *     target card (or its left port); Esc cancels
 *   - click an edge to select it; Delete / "O'chirish" removes it
 *   - the inspector under / beside the canvas has the same "Keyingi qadam"
 *     selectors, so everything is also reachable without a pointer
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ConfirmButton } from "@/components/developer/comments/parts";
import { inputClass, secondaryButton } from "@/components/developer/ui";
import type { FlowGraph, FlowNode, FlowNodeType } from "@/lib/flows/schema";
import {
  ADDABLE_TYPES,
  autoLayout,
  defaultNode,
  describeNode,
  edgeTarget,
  HANDLE_ROW,
  handlesOf,
  newNodeId,
  NODE_HEADER,
  nodeHeight,
  nodeTitle,
  NODE_W,
  removeEdge,
  removeNode,
  setEdge,
  updateNode,
  withLayout,
} from "./graph-edit";
import NodeInspector from "./node-inspector";
import type { FlowsMeta, MetaAccount } from "./shared";

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.3;
const MAX_K = 1.6;

type Pos = { x: number; y: number };

function portOut(pos: Pos, index: number): Pos {
  return { x: pos.x + NODE_W, y: pos.y + NODE_HEADER + index * HANDLE_ROW + HANDLE_ROW / 2 };
}
function portIn(pos: Pos): Pos {
  return { x: pos.x, y: pos.y + 22 };
}
function curve(a: Pos, b: Pos): string {
  const dx = Math.max(48, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

export default function Canvas({
  graph,
  onChange,
  meta,
  account,
  selectedId,
  onSelect,
  focusTick,
  readOnly,
}: {
  graph: FlowGraph;
  onChange: (next: FlowGraph) => void;
  meta: FlowsMeta | null;
  account: MetaAccount | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  focusTick?: number;
  readOnly?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [pending, setPending] = useState<{ from: string; handle: string } | null>(null);
  const [pointer, setPointer] = useState<Pos | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; to: string; handle: string } | null>(null);
  const [addType, setAddType] = useState<FlowNodeType>("message");

  const base = useMemo(() => withLayout(graph), [graph]);
  const positions = useMemo(() => (drag ? { ...base, [drag.id]: { x: drag.x, y: drag.y } } : base), [base, drag]);
  const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const selected = selectedId ? (nodesById.get(selectedId) ?? null) : null;
  const maxNodes = meta?.limits.nodes ?? 120;

  const toGraphSpace = useCallback((clientX: number, clientY: number): Pos => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - (rect?.left ?? 0) - v.x) / v.k, y: (clientY - (rect?.top ?? 0) - v.y) / v.k };
  }, []);

  // Wheel zoom around the cursor (native listener: React's is passive and cannot stop the page scroll).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const fit = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const all = Object.entries(base);
    if (all.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [id, pos] of all) {
      const node = nodesById.get(id);
      if (!node) continue;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + NODE_W);
      maxY = Math.max(maxY, pos.y + nodeHeight(node));
    }
    const w = maxX - minX + 80;
    const h = maxY - minY + 80;
    const k = Math.min(1, Math.max(MIN_K, Math.min(el.clientWidth / w, el.clientHeight / h)));
    setView({ k, x: 40 - minX * k, y: 40 - minY * k });
  }, [base, nodesById]);

  useEffect(() => {
     
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit on mount only
  }, []);

  // Focus request from the audit panel: centre the node.
  useEffect(() => {
    if (!selectedId || !focusTick) return;
    const el = viewportRef.current;
    const pos = base[selectedId];
    if (!el || !pos) return;
     
    setView((v) => ({ ...v, x: el.clientWidth / 2 - (pos.x + NODE_W / 2) * v.k, y: el.clientHeight / 2 - (pos.y + 40) * v.k }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a new focus request
  }, [focusTick]);

  function commitLayout(id: string, pos: Pos) {
    onChange({ ...graph, layout: { ...base, [id]: { x: Math.round(pos.x), y: Math.round(pos.y) } } });
  }

  // ── node drag ──
  function onHeaderDown(event: ReactPointerEvent, node: FlowNode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const pos = positions[node.id];
    dragRef.current = { id: node.id, startX: event.clientX, startY: event.clientY, originX: pos.x, originY: pos.y, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function onHeaderMove(event: ReactPointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = (event.clientX - d.startX) / viewRef.current.k;
    const dy = (event.clientY - d.startY) / viewRef.current.k;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (!readOnly) setDrag({ id: d.id, x: d.originX + dx, y: d.originY + dy });
  }
  function onHeaderUp(event: ReactPointerEvent, node: FlowNode) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // capture already released
    }
    if (d.moved && drag) {
      commitLayout(d.id, { x: drag.x, y: drag.y });
    } else {
      // A click, not a drag.
      if (pending) connectTo(node.id);
      else {
        onSelect(node.id);
        setSelectedEdge(null);
      }
    }
    setDrag(null);
  }

  // ── pan ──
  function onViewportDown(event: ReactPointerEvent) {
    if (event.button !== 0) return;
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).dataset.pan) return;
    panRef.current = { startX: event.clientX, startY: event.clientY, originX: viewRef.current.x, originY: viewRef.current.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    onSelect(null);
    setSelectedEdge(null);
    if (pending) setPending(null);
  }
  function onViewportMove(event: ReactPointerEvent) {
    const p = panRef.current;
    if (p) setView((v) => ({ ...v, x: p.originX + event.clientX - p.startX, y: p.originY + event.clientY - p.startY }));
    if (pending) setPointer(toGraphSpace(event.clientX, event.clientY));
  }
  function onViewportUp(event: ReactPointerEvent) {
    if (panRef.current) {
      panRef.current = null;
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      } catch {
        // already released
      }
    }
  }

  // ── connect ──
  function connectTo(targetId: string) {
    if (!pending || readOnly) return;
    if (targetId !== pending.from && nodesById.get(targetId)?.type !== "trigger") onChange(setEdge(graph, pending.from, pending.handle, targetId));
    setPending(null);
    setPointer(null);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    if (event.key === "Escape") {
      setPending(null);
      setSelectedEdge(null);
    } else if ((event.key === "Delete" || event.key === "Backspace") && !readOnly) {
      if (selectedEdge) {
        onChange(removeEdge(graph, selectedEdge));
        setSelectedEdge(null);
      } else if (selected && selected.type !== "trigger") {
        onChange(removeNode(graph, selected.id));
        onSelect(null);
      }
    }
  }

  function addNode() {
    if (graph.nodes.length >= maxNodes) return;
    const node = defaultNode(addType, newNodeId(graph, addType), meta);
    const el = viewportRef.current;
    const centre = el ? toGraphSpace(el.getBoundingClientRect().left + el.clientWidth / 2, el.getBoundingClientRect().top + el.clientHeight / 2) : { x: 0, y: 0 };
    onChange({ ...graph, nodes: [...graph.nodes, node], layout: { ...base, [node.id]: { x: Math.round(centre.x - NODE_W / 2), y: Math.round(centre.y - 40) } } });
    onSelect(node.id);
  }

  const edges = graph.edges
    .map((edge) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to || !positions[edge.from] || !positions[edge.to]) return null;
      const index = handlesOf(from).findIndex((h) => h.handle === edge.handle);
      if (index < 0) return null;
      return { edge, d: curve(portOut(positions[edge.from], index), portIn(positions[edge.to])) };
    })
    .filter((e): e is { edge: (typeof graph.edges)[number]; d: string } => e !== null);

  const pendingStart = (() => {
    if (!pending) return null;
    const node = nodesById.get(pending.from);
    if (!node || !positions[pending.from]) return null;
    const index = handlesOf(node).findIndex((h) => h.handle === pending.handle);
    return index < 0 ? null : portOut(positions[pending.from], index);
  })();

  const edgeIsSelected = (e: { from: string; to: string; handle: string }) => selectedEdge && selectedEdge.from === e.from && selectedEdge.to === e.to && selectedEdge.handle === e.handle;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!readOnly && (
          <>
            <select aria-label="Qo'shiladigan blok turi" className={`${inputClass} !w-auto`} value={addType} onChange={(e) => setAddType(e.target.value as FlowNodeType)}>
              {ADDABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {meta?.nodeLabels[t] ?? t}
                </option>
              ))}
            </select>
            <button type="button" className={secondaryButton} disabled={graph.nodes.length >= maxNodes} onClick={addNode}>
              + Blok
            </button>
            <button type="button" className={secondaryButton} onClick={() => onChange({ ...graph, layout: autoLayout(graph) })}>
              Avto-joylash
            </button>
          </>
        )}
        <button type="button" className={secondaryButton} onClick={fit}>
          Moslashtirish
        </button>
        <button type="button" className={secondaryButton} aria-label="Kichraytirish" onClick={() => setView((v) => ({ ...v, k: Math.max(MIN_K, v.k / 1.2) }))}>
          −
        </button>
        <span className="w-12 text-center text-xs tabular-nums text-muted">{Math.round(view.k * 100)}%</span>
        <button type="button" className={secondaryButton} aria-label="Kattalashtirish" onClick={() => setView((v) => ({ ...v, k: Math.min(MAX_K, v.k * 1.2) }))}>
          +
        </button>
        {!readOnly && selectedEdge && (
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              onChange(removeEdge(graph, selectedEdge));
              setSelectedEdge(null);
            }}
          >
            Bog&apos;lanishni o&apos;chirish
          </button>
        )}
        <span className="ml-auto text-xs text-muted">
          {graph.nodes.length}/{maxNodes} blok
        </span>
      </div>

      {pending && (
        <p role="status" className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-foreground">
          «{pending.from}» → {pending.handle}: endi maqsad blokni bosing. Bekor qilish: Esc yoki bo&apos;sh joyni bosing.
        </p>
      )}

      <div
        ref={viewportRef}
        tabIndex={0}
        role="application"
        aria-label="Oqim kanvasi"
        onKeyDown={onKeyDown}
        onPointerDown={onViewportDown}
        onPointerMove={onViewportMove}
        onPointerUp={onViewportUp}
        className="relative h-[68vh] min-h-[22rem] touch-none overflow-hidden rounded-xl border border-border bg-background outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(180,182,255,0.14) 1px, transparent 1px)",
          backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <div data-pan="1" className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}>
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden="true">
            <defs>
              <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {edges.map(({ edge, d }) => {
              const on = edgeIsSelected(edge);
              return (
                <g key={`${edge.from}|${edge.handle}|${edge.to}`} className={on ? "text-accent" : "text-muted"}>
                  <path d={d} fill="none" stroke="currentColor" strokeWidth={on ? 2.5 : 1.5} markerEnd="url(#flow-arrow)" />
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEdge(edge);
                      onSelect(null);
                      viewportRef.current?.focus();
                    }}
                  />
                </g>
              );
            })}
            {pendingStart && pointer && <path d={curve(pendingStart, pointer)} fill="none" stroke="currentColor" strokeDasharray="5 4" strokeWidth={1.5} className="text-accent" />}
          </svg>

          {graph.nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            const handles = handlesOf(node);
            const isSelected = selectedId === node.id;
            const missing = handles.some((h) => h.required && !edgeTarget(graph, node.id, h.handle));
            return (
              <div
                key={node.id}
                role="group"
                aria-label={`${nodeTitle(node)} ${node.id}`}
                className={`absolute rounded-xl border bg-surface shadow-lg ${isSelected ? "border-accent ring-1 ring-accent/50" : missing ? "border-error/50" : "border-border-hover"} ${pending && node.type !== "trigger" && node.id !== pending.from ? "cursor-crosshair" : ""}`}
                style={{ left: pos.x, top: pos.y, width: NODE_W, height: nodeHeight(node) }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  if (pending) connectTo(node.id);
                }}
              >
                {node.type !== "trigger" && (
                  <button
                    type="button"
                    aria-label={`${node.id} blokiga ulash`}
                    disabled={!pending}
                    onClick={(e) => {
                      e.stopPropagation();
                      connectTo(node.id);
                    }}
                    className={`absolute -left-2 top-4 h-4 w-4 rounded-full border-2 ${pending ? "border-accent bg-accent/30" : "border-border-hover bg-surface"}`}
                  />
                )}
                <div
                  className="flex h-[44px] cursor-grab touch-none select-none flex-col justify-center rounded-t-xl border-b border-border bg-surface-hover px-3 active:cursor-grabbing"
                  onPointerDown={(e) => onHeaderDown(e, node)}
                  onPointerMove={onHeaderMove}
                  onPointerUp={(e) => onHeaderUp(e, node)}
                  onPointerCancel={() => {
                    dragRef.current = null;
                    setDrag(null);
                  }}
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                    {nodeTitle(node)}
                    <span className="label-mono text-[9px] font-normal text-muted">{node.id}</span>
                  </span>
                  <span className="truncate text-[11px] text-muted">{describeNode(node, meta)}</span>
                </div>
                <ul>
                  {handles.length === 0 && <li className="px-3 text-[11px] text-muted" style={{ height: HANDLE_ROW, lineHeight: `${HANDLE_ROW}px` }}>oqim tugaydi</li>}
                  {handles.map(({ handle, label, required }) => {
                    const target = edgeTarget(graph, node.id, handle);
                    const armed = pending?.from === node.id && pending.handle === handle;
                    return (
                      <li key={handle} className="relative flex items-center justify-between gap-2 pl-3 pr-4 text-[11px]" style={{ height: HANDLE_ROW }}>
                        <span className={`truncate ${required && !target ? "text-error" : "text-muted"}`}>{label}</span>
                        <button
                          type="button"
                          disabled={readOnly}
                          aria-label={`${node.id}: ${label} — ulash`}
                          aria-pressed={armed}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedEdge(null);
                            setPending(armed ? null : { from: node.id, handle });
                          }}
                          className={`absolute -right-2 h-4 w-4 rounded-full border-2 ${armed ? "border-accent bg-accent" : target ? "border-muted bg-muted/50" : required ? "border-error bg-surface" : "border-border-hover bg-surface"}`}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <section aria-label={`${selected.id} sozlamalari`} className="panel space-y-3 rounded-xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {nodeTitle(selected)} <span className="label-mono text-[10px] font-normal text-muted">{selected.id}</span>
            </h3>
            {!readOnly && selected.type !== "trigger" && (
              <ConfirmButton
                label="Blokni o'chirish"
                question="O'chirilsinmi?"
                confirmLabel="O'chirish"
                danger
                onConfirm={() => {
                  onChange(removeNode(graph, selected.id));
                  onSelect(null);
                }}
              />
            )}
          </div>
          <fieldset disabled={readOnly} className="min-w-0">
            <NodeInspector
              node={selected}
              graph={graph}
              meta={meta}
              account={account}
              onChange={(next, rename) => onChange(updateNode(graph, selected.id, next, rename))}
              onEdge={(handle, to) => onChange(setEdge(graph, selected.id, handle, to))}
            />
          </fieldset>
        </section>
      )}
    </div>
  );
}
