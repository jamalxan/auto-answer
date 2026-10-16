"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { EmptyState, formatDateTime, inputClass, Pill, secondaryButton } from "@/components/developer/ui";
import { ACTION_STATUS, MCP_API, requestJson, type ActionRow, type McpMeta } from "./shared";

/** Audit log of proposed / confirmed writes, with a status and tool filter. */
export default function ActionsLog({ meta, refreshKey }: { meta: McpMeta; refreshKey: number }) {
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [status, setStatus] = useState("");
  const [tool, setTool] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (tool) params.set("tool", tool);
    try {
      const res = await requestJson<ActionRow[]>(`${MCP_API}/actions?${params.toString()}`);
      if (res.ok) setRows(Array.isArray(res.data) ? res.data : []);
      else setError(res.error);
    } finally {
      setLoading(false);
    }
  }, [status, tool]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    void load();
  }, [load, refreshKey]);

  const writeTools = meta.tools.filter((t) => t.kind === "write");

  return (
    <section className="panel space-y-4 rounded-xl p-4 sm:p-5" aria-labelledby="mcp-log">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="mcp-log" className="text-sm font-semibold text-foreground">
          Amallar jurnali
        </h2>
        <div className="flex flex-wrap gap-2">
          <select className={`${inputClass} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Holat bo'yicha filtr">
            <option value="">Barcha holatlar</option>
            {Object.entries(ACTION_STATUS).map(([key, v]) => (
              <option key={key} value={key}>
                {v.label}
              </option>
            ))}
          </select>
          <select className={`${inputClass} w-auto`} value={tool} onChange={(e) => setTool(e.target.value)} aria-label="Asbob bo'yicha filtr">
            <option value="">Barcha asboblar</option>
            {writeTools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {rows.length === 0 && !loading ? (
        <EmptyState title="Hali amal yo'q" body="WRITE token bilan yozish asbobi chaqirilganda taklif va natija shu yerda ko'rinadi." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="label-mono text-[11px] text-muted">
                <th className="py-2 pr-3 font-semibold">Vaqt</th>
                <th className="py-2 pr-3 font-semibold">Asbob</th>
                <th className="py-2 pr-3 font-semibold">Qisqacha</th>
                <th className="py-2 pr-3 font-semibold">Token</th>
                <th className="py-2 font-semibold">Holat</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = ACTION_STATUS[r.status] ?? { label: r.status, tone: "muted" as const };
                const expanded = open === r.id;
                return (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted">{formatDateTime(r.createdAt)}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{r.tool}</td>
                    <td className="py-2 pr-3">
                      <button type="button" className="text-left text-sm text-foreground hover:underline" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                        {r.summary || "—"}
                      </button>
                      {r.error && <p className="mt-0.5 text-xs text-error">{r.error}</p>}
                      {expanded && (
                        <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-surface p-2 text-[11px]">
                          {JSON.stringify({ preview: r.preview, result: r.result }, null, 2)}
                        </pre>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted">{r.tokenName ?? "—"}</td>
                    <td className="py-2">
                      <Pill tone={st.tone}>{st.label}</Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
