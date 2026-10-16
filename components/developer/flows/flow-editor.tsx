"use client";

/**
 * One flow: header (name, status, mode, save, unsaved indicator) and the
 * tabs Qurish (Simple stacked blocks or Advanced canvas — the same graph),
 * Audit, Test, Versiyalar, Ishga tushishlar, Nashr. The graph lives here;
 * every child edits it through onChange. Saving always goes through
 * PUT /draft (in place while unpublished, a new version after a publish).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import type { FlowGraph } from "@/lib/flows/schema";
import AuditPanel from "./audit-panel";
import Canvas from "./canvas";
import PublishPanel from "./publish-panel";
import RunsTab from "./runs-tab";
import SimpleEditor from "./simple-editor";
import TestConsole from "./test-console";
import VersionsTab from "./versions-tab";
import { FLOWS_API, jsonInit, requestJson, SOURCE_TEXT, STATUS_TEXT, type Evaluation, type FlowDetail, type FlowMode, type FlowsMeta } from "./shared";

export const EDITOR_TABS = [
  ["builder", "Qurish"],
  ["audit", "Audit"],
  ["test", "Test"],
  ["versions", "Versiyalar"],
  ["runs", "Ishga tushishlar"],
  ["publish", "Nashr"],
] as const;
export type EditorTab = (typeof EDITOR_TABS)[number][0];

interface SaveResponse {
  version: { id: string };
  evaluation: Evaluation;
}

export default function FlowEditor({
  flowId,
  meta,
  canWrite,
  tab,
  onTab,
  onBack,
}: {
  flowId: string;
  meta: FlowsMeta | null;
  canWrite: boolean;
  tab: EditorTab;
  onTab: (tab: EditorTab) => void;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [baseline, setBaseline] = useState("");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [versionsKey, setVersionsKey] = useState(0);
  const [focus, setFocus] = useState<{ id: string | null; tick: number }>({ id: null, tick: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const loadSeq = useRef(0);
  const saveSeq = useRef(0);

  const dirty = graph !== null && JSON.stringify(graph) !== baseline;
  const readOnly = !canWrite || detail?.flow.status === "ARCHIVED";
  const flowAccountId = detail?.flow.instagramAccountId;
  const account = useMemo(() => meta?.accounts.find((a) => a.id === flowAccountId) ?? null, [meta, flowAccountId]);

  const load = useCallback(
    async (opts: { resetGraph: boolean }) => {
      const mine = ++loadSeq.current;
      setLoading(true);
      try {
        const res = await requestJson<FlowDetail>(`${FLOWS_API}/${flowId}`);
        if (mine !== loadSeq.current) return;
        if (!res.ok) {
          setFailure(res.error);
          return;
        }
        setFailure(null);
        setDetail(res.data);
        setName(res.data.flow.name);
        if (opts.resetGraph && res.data.current) {
          setGraph(res.data.current.graph);
          setBaseline(JSON.stringify(res.data.current.graph));
        }
        const d = res.data.draft;
        if (opts.resetGraph) {
          setEvaluation(d?.audit && d.policy ? { audit: d.audit, policy: d.policy, hash: d.hash, structural: [], publishable: d.audit.errors.length === 0 && d.policy.verdict !== "BLOCKED" } : null);
        }
      } finally {
        if (mine === loadSeq.current) setLoading(false);
      }
    },
    [flowId]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load({ resetGraph: true });
    const counter = loadSeq;
    return () => {
      counter.current++;
    };
  }, [load]);

  // Leaving with unsaved changes asks the browser.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  /** Saves the graph. Resolves the saved version id, or null (the error is shown). */
  const save = useCallback(async (): Promise<string | null> => {
    if (!graph || readOnly) return null;
    const mine = ++saveSeq.current;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await requestJson<SaveResponse>(`${FLOWS_API}/${flowId}/draft`, { ...jsonInit("PUT", { graph }) });
      if (mine !== saveSeq.current) return null;
      if (!res.ok) {
        setSaveError(res.error);
        return null;
      }
      setBaseline(JSON.stringify(graph));
      setEvaluation(res.data.evaluation);
      setVersionsKey((k) => k + 1);
      await load({ resetGraph: false });
      return res.data.version.id;
    } finally {
      if (mine === saveSeq.current) setSaving(false);
    }
  }, [graph, readOnly, flowId, load]);

  async function ensureSaved(): Promise<string | null> {
    if (dirty) return save();
    return detail?.draft?.id ?? detail?.current?.versionId ?? null;
  }

  async function rerunAudit() {
    const versionId = dirty ? await save() : (detail?.draft?.id ?? detail?.current?.versionId ?? null);
    if (!versionId) return;
    setAuditBusy(true);
    try {
      const res = await requestJson<Evaluation & { versionId: string }>(`${FLOWS_API}/${flowId}/versions/${versionId}/audit`, jsonInit("POST", {}));
      if (res.ok) setEvaluation(res.data);
      else setSaveError(res.error);
    } finally {
      setAuditBusy(false);
    }
  }

  async function patchFlow(body: { name?: string; mode?: FlowMode }) {
    const res = await requestJson<unknown>(`${FLOWS_API}/${flowId}`, jsonInit("PATCH", body));
    if (res.ok) await load({ resetGraph: false });
    else setSaveError(res.error);
  }

  function focusNode(id: string) {
    setFocus((f) => ({ id, tick: f.tick + 1 }));
    setSelectedId(id);
    onTab("builder");
  }

  if (failure && !detail) {
    return (
      <div className="space-y-3">
        <Notice tone="error">{failure}</Notice>
        <button type="button" className={secondaryButton} onClick={onBack}>
          ← Oqimlar ro&apos;yxati
        </button>
      </div>
    );
  }
  if (!detail || !graph) return <p className="py-10 text-center text-sm text-muted">{loading ? "Yuklanmoqda…" : ""}</p>;

  const flow = detail.flow;
  const status = STATUS_TEXT[flow.status];
  const errors = evaluation?.audit.errors.length ?? 0;
  const mode = flow.mode;
  const draft = detail.draft;
  const editingPublished = !detail.current?.editable && !!detail.published;

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {dirty ? (
            <ConfirmButton label="← Ro'yxat" question="Saqlanmagan o'zgarishlar yo'qoladi. Chiqasizmi?" confirmLabel="Chiqish" danger onConfirm={onBack} />
          ) : (
            <button type="button" className={secondaryButton} onClick={onBack}>
              ← Ro&apos;yxat
            </button>
          )}
          <Pill tone={status.tone}>{status.label}</Pill>
          {draft && <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[11px] text-muted">v{draft.version} qoralama · {SOURCE_TEXT[draft.source]}</span>}
          {detail.published && <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] text-success">v{detail.published.version} ishlayapti</span>}
          <span className="text-xs text-muted">@{flow.accountUsername ?? "—"}</span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-sm">
            <span className="sr-only">Oqim nomi</span>
            <input
              className={`${inputClass} font-display text-lg font-bold`}
              value={name}
              maxLength={120}
              disabled={readOnly}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (name.trim() && name.trim() !== flow.name) void patchFlow({ name: name.trim() });
                else setName(flow.name);
              }}
            />
          </label>
          <div role="group" aria-label="Tahrirlash rejimi" className="inline-flex overflow-hidden rounded-lg border border-border text-sm">
            {(["SIMPLE", "ADVANCED"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                disabled={readOnly}
                onClick={() => mode !== m && void patchFlow({ mode: m })}
                className={`px-3 py-1.5 font-medium ${mode === m ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground"}`}
              >
                {m === "SIMPLE" ? "Oddiy" : "Kengaytirilgan"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {dirty && (
              <span role="status" className="flex items-center gap-1.5 text-xs text-warning">
                <span className="h-2 w-2 rounded-full bg-warning" aria-hidden="true" />
                Saqlanmagan o&apos;zgarishlar
              </span>
            )}
            <button type="button" className={primaryButton} disabled={!dirty || saving || readOnly} onClick={() => void save()}>
              {saving ? "Saqlanmoqda…" : "Saqlash"}
            </button>
          </div>
        </div>
        {meta?.disabled && <Notice tone="error">Flow&apos;lar serverda o&apos;chirilgan (FLOWS_DISABLED): ishga tushirib bo&apos;lmaydi, mavjud oqimlar ishlamaydi.</Notice>}
        {saveError && <Notice tone="error">{saveError}</Notice>}
        {editingPublished && !readOnly && (
          <Notice tone="info">Ishlayotgan v{detail.published?.version} ochiq. O&apos;zgartirib saqlasangiz, yangi qoralama (v{(detail.published?.version ?? 0) + 1}) ochiladi; ishlayotgan oqim o&apos;zgarmaydi.</Notice>
        )}
        {!canWrite && <Notice tone="info">Siz faqat ko&apos;ra olasiz (kuzatuvchi roli).</Notice>}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {EDITOR_TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => onTab(key)}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {label}
            {key === "audit" && errors > 0 && <span className="rounded-full bg-error/20 px-1.5 text-[11px] text-error">{errors}</span>}
            {key === "runs" && detail.stats.activeRuns > 0 && <span className="rounded-full bg-accent/20 px-1.5 text-[11px] text-accent">{detail.stats.activeRuns}</span>}
          </button>
        ))}
      </div>

      {tab === "builder" &&
        (mode === "SIMPLE" ? (
          <SimpleEditor graph={graph} onChange={setGraph} meta={meta} account={account} focusId={focus.id} focusTick={focus.tick} readOnly={readOnly} />
        ) : (
          <Canvas graph={graph} onChange={setGraph} meta={meta} account={account} selectedId={selectedId} onSelect={setSelectedId} focusTick={focus.tick} readOnly={readOnly} />
        ))}

      {tab === "audit" && <AuditPanel evaluation={evaluation} loading={auditBusy || saving} stale={dirty} onRerun={() => void rerunAudit()} onFocus={focusNode} />}

      {tab === "test" && (
        <TestConsole
          flowId={flowId}
          graph={graph}
          dirty={dirty}
          canRun={canWrite}
          ensureSaved={ensureSaved}
          onTested={() => {
            setVersionsKey((k) => k + 1);
            void load({ resetGraph: false });
          }}
        />
      )}

      {tab === "versions" && (
        <VersionsTab
          flowId={flowId}
          refreshKey={versionsKey}
          dirty={dirty}
          onRestored={() => {
            setVersionsKey((k) => k + 1);
            void load({ resetGraph: true });
            onTab("builder");
          }}
        />
      )}

      {tab === "runs" && <RunsTab flowId={flowId} canWrite={canWrite} />}

      {tab === "publish" && (
        <PublishPanel
          detail={detail}
          evaluation={evaluation}
          dirty={dirty}
          canWrite={canWrite && !readOnly}
          busy={auditBusy}
          onRunAudit={() => void rerunAudit()}
          onFocus={focusNode}
          onChanged={() => {
            setVersionsKey((k) => k + 1);
            void load({ resetGraph: !dirty });
          }}
          onDeleted={onBack}
        />
      )}
    </div>
  );
}
