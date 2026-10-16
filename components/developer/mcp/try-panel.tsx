"use client";

import { ServerOffNotice } from "@/components/developer/server-off";
import { useEffect, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Field, inputClass, primaryButton } from "@/components/developer/ui";
import type { McpMeta } from "./shared";

/**
 * "Try it": a real call to POST /api/mcp from the browser with a token the person
 * pastes (or the one just created, kept in memory only). Shows tools/list.
 */
export default function TryPanel({ meta, freshToken }: { meta: McpMeta; freshToken: string }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt the token created a moment ago
    if (freshToken) setToken(freshToken);
  }, [freshToken]);

  async function call() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOutput(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const body = (await res.json().catch(() => null)) as { result?: { tools?: Array<{ name: string; description: string }> }; error?: unknown } | null;
      if (!res.ok) {
        const message = body && typeof body.error === "string" ? body.error : `So'rov bajarilmadi (${res.status})`;
        setError(message);
        setTools([]);
        return;
      }
      setTools(body?.result?.tools ?? []);
      setOutput(JSON.stringify(body, null, 2));
    } catch {
      setError("Server bilan aloqa yo'q — internetni tekshirib, qayta urinib ko'ring");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel space-y-4 rounded-xl p-4 sm:p-5" aria-labelledby="mcp-try">
      <h2 id="mcp-try" className="text-sm font-semibold text-foreground">
        Sinab ko&apos;rish: tools/list
      </h2>
      <p className="text-xs text-muted">
        Brauzerdan haqiqiy <code>POST {meta.endpoint}</code> chaqiriladi. Token faqat shu so&apos;rovga ishlatiladi va saqlanmaydi.
      </p>
      {!meta.enabled && <ServerOffNotice what="MCP o'chirilgan: endpoint 503 qaytaradi." ops={<><code>MCP_DISABLED</code> ni olib tashlang.</>} />}
      <Field label="Token" hint="Yangi yaratilgan token shu yerga o'zi tushadi.">
        <input
          type="password"
          className={inputClass}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          aria-label="Sinov tokeni"
          placeholder={`${meta.limits.tokenPrefix}…`}
        />
      </Field>
      <button type="button" className={primaryButton} disabled={busy || token.trim().length < 10} onClick={() => void call()}>
        {busy ? "So'ralmoqda…" : "tools/list chaqirish"}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
      {tools.length > 0 && (
        <ul className="space-y-1 text-sm">
          {tools.map((t) => (
            <li key={t.name} className="rounded-lg border border-border px-3 py-2">
              <span className="font-mono text-xs text-foreground">{t.name}</span>
              <span className="mt-0.5 block text-xs text-muted">{t.description.split(". ")[0]}</span>
            </li>
          ))}
        </ul>
      )}
      {output && <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-surface p-3 text-[11px]">{output}</pre>}
    </section>
  );
}
