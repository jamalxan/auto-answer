"use client";

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Choice, EmptyState, Field, formatDateTime, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import CopyButton from "./copy-button";
import { connectionSnippets, jsonInit, MCP_API, requestJson, tokenState, type CreatedToken, type McpMeta, type TokenRow } from "./shared";

/** Create (the raw token is shown once), list and revoke. */
export default function TokenPanel({
  meta,
  tokens,
  onChanged,
  onCreated,
}: {
  meta: McpMeta;
  tokens: TokenRow[];
  onChanged: () => void;
  /** The raw token is handed to the try-it panel (memory only). */
  onCreated: (token: string) => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"READ" | "WRITE">("READ");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const canCreate = meta.me.canManage && meta.enabled;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), scope };
      if (days.trim()) body.expiresInDays = Number(days);
      const res = await requestJson<CreatedToken>(`${MCP_API}/tokens`, jsonInit("POST", body));
      if (res.ok) {
        setCreated(res.data);
        onCreated(res.data.token);
        setName("");
        setDays("");
        onChanged();
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${MCP_API}/tokens/${id}`, { method: "DELETE" });
      if (!res.ok) setError(res.error);
      setRevoking(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const snippets = created ? connectionSnippets(meta.endpoint, created.token) : null;

  return (
    <div className="space-y-6">
      {created && snippets && (
        <section className="panel space-y-3 rounded-xl border border-warning/40 p-4 sm:p-5" aria-label="Yangi token">
          <h2 className="text-sm font-semibold text-foreground">Token tayyor — uni hozir nusxalang</h2>
          <Notice tone="warning">
            Token faqat shu yerda, bir marta ko&apos;rsatiladi. Sahifani yopsangiz qayta ko&apos;rib bo&apos;lmaydi (faqat oxirgi 4 belgisi saqlanadi). Yo&apos;qotsangiz — yangisini yarating.
          </Notice>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface px-3 py-2 text-xs" data-testid="raw-token">
              {created.token}
            </code>
            <CopyButton text={created.token} label="Tokenni nusxalash" />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted">Claude Code</p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-3 text-xs">{snippets.claudeCode}</pre>
            <CopyButton text={snippets.claudeCode} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted">Claude Desktop (claude_desktop_config.json, mcp-remote orqali)</p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-3 text-xs">{snippets.claudeDesktop}</pre>
            <CopyButton text={snippets.claudeDesktop} />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted">ChatGPT va boshqalar (MCP server URL + Authorization sarlavhasi)</p>
            <p className="text-xs text-muted">
              URL: <code>{snippets.url}</code>. Sarlavha: <code>Authorization: Bearer …</code>. ChatGPT&apos;ning custom connector&apos;i faqat OAuth&apos;ni qo&apos;llashi mumkin — u holda token bilan ulanmaydi (README&apos;ga qarang).
            </p>
            <CopyButton text={snippets.url} label="URL'ni nusxalash" />
          </div>
          <button type="button" className={secondaryButton} onClick={() => setCreated(null)}>
            Nusxaladim, yopish
          </button>
        </section>
      )}

      <section className="panel space-y-4 rounded-xl p-4 sm:p-5" aria-labelledby="mcp-new">
        <h2 id="mcp-new" className="text-sm font-semibold text-foreground">
          Yangi token
        </h2>
        {!meta.me.canManage && <Notice tone="warning">Token yaratish uchun workspace egasi yoki administrator bo&apos;lish kerak.</Notice>}
        <form onSubmit={create} className="space-y-4" autoComplete="off">
          <Field label="Nomi" hint="Masalan: Claude Desktop (Jamol)">
            <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={!canCreate || busy} aria-label="Token nomi" />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Ruxsat darajasi">
            <Choice checked={scope === "READ"} disabled={!canCreate || busy} onSelect={() => setScope("READ")} title="Faqat o'qish (READ)" description="Kampaniya, flow, lid, analitika va diagnostikani o'qiydi." />
            <Choice
              checked={scope === "WRITE"}
              disabled={!canCreate || busy}
              onSelect={() => setScope("WRITE")}
              title="O'qish + yozish (WRITE)"
              description="Kampaniya, flow qoralamasi, teg va bosqich o'zgartirishni taklif qiladi; har biri alohida tasdiq kodi bilan bajariladi."
            />
          </div>
          <Field label="Muddati (kun, ixtiyoriy)" hint="Bo'sh = muddatsiz. Eng ko'pi 365 kun.">
            <input className={inputClass} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} disabled={!canCreate || busy} aria-label="Muddati (kun)" />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <button type="submit" className={primaryButton} disabled={!canCreate || busy || name.trim().length === 0}>
            {busy ? "Yaratilmoqda…" : "Token yaratish"}
          </button>
        </form>
      </section>

      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="mcp-tokens">
        <h2 id="mcp-tokens" className="text-sm font-semibold text-foreground">
          Tokenlar
        </h2>
        {tokens.length === 0 ? (
          <EmptyState title="Hali token yo'q" body="Yuqoridan birinchi tokenni yarating." />
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => {
              const state = tokenState(t);
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {t.name} <span className="label-mono ml-1 text-[10px] text-muted">{t.scope}</span>
                    </p>
                    <p className="text-xs text-muted">
                      …{t.tokenHint} · oxirgi ishlatilgan: {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "hech qachon"} · yaratilgan {formatDateTime(t.createdAt)}
                      {t.expiresAt ? ` · muddati ${formatDateTime(t.expiresAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={state.tone}>{state.label}</Pill>
                    {!t.revokedAt &&
                      meta.me.canManage &&
                      (revoking === t.id ? (
                        <span className="flex items-center gap-2" role="group" aria-label="Bekor qilishni tasdiqlash">
                          <button type="button" className={primaryButton} disabled={busy} onClick={() => void revoke(t.id)}>
                            Ha, bekor qilish
                          </button>
                          <button type="button" className={secondaryButton} disabled={busy} onClick={() => setRevoking(null)}>
                            Yo&apos;q
                          </button>
                        </span>
                      ) : (
                        <button type="button" className={secondaryButton} onClick={() => setRevoking(t.id)} aria-label={`${t.name} tokenini bekor qilish`}>
                          Bekor qilish
                        </button>
                      ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
