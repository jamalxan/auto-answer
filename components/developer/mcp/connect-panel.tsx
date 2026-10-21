"use client";

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { EmptyState, formatDateTime, Pill, secondaryButton } from "@/components/developer/ui";
import CopyButton from "./copy-button";
import { connectionSnippets, tokenState, type McpMeta, type TokenRow } from "./shared";

/**
 * ETAP 12 — "Ulanish": how an AI client connects. The server URL is enough:
 * the client discovers OAuth through /.well-known, registers itself, sends the
 * person to the consent screen and gets its token. Hand-made tokens stay
 * available for clients without OAuth (Tokenlar tab).
 */

const CLIENTS = [
  {
    key: "claude-web",
    title: "Claude.ai va Claude Desktop",
    steps: [
      "Claude'da Settings → Connectors → \"Add custom connector\" ni oching.",
      "Name: SocialAuto. URL maydoniga pastdagi server manzilini qo'ying va \"Add\" ni bosing.",
      "\"Connect\" ni bosing: brauzerda SocialAuto'ning ruxsat sahifasi ochiladi (developer login + oddiy login kerak).",
      "Ruxsat darajasini tanlab \"Ruxsat berish\" ni bosing — Claude ulanadi va asboblar ro'yxati ko'rinadi.",
    ],
  },
  {
    key: "claude-code",
    title: "Claude Code (terminal)",
    steps: ["Pastdagi buyruqni terminalda bajaring.", "Claude Code ichida /mcp ni yozib, socialauto → \"Authenticate\" ni tanlang; brauzerda ruxsat bering."],
    command: true,
  },
  {
    key: "chatgpt",
    title: "ChatGPT (Developer mode / Connectors)",
    steps: [
      "ChatGPT'da Settings → Connectors → Advanced → Developer mode ni yoqing.",
      "\"Create\" ni bosib, MCP Server URL maydoniga server manzilini qo'ying; Authentication: OAuth.",
      "\"Create\" dan keyin ChatGPT sizni SocialAuto ruxsat sahifasiga yuboradi — ruxsat bering.",
    ],
  },
  {
    key: "other",
    title: "Boshqa MCP mijozlar (Cursor, Windsurf, Inspector, …)",
    steps: [
      "Transport: Streamable HTTP, URL: server manzili. Auth: OAuth (avtomatik) yoki \"Tokenlar\" bo'limidagi qo'lda yaratilgan token (Authorization: Bearer sa_mcp_…).",
    ],
  },
] as const;

export default function ConnectPanel({ meta, tokens, onManage }: { meta: McpMeta; tokens: TokenRow[]; onManage: () => void }) {
  const [open, setOpen] = useState<string>("claude-web");
  const connected = tokens.filter((t) => t.source === "OAUTH" && !t.revokedAt);
  const snippets = connectionSnippets(meta.endpoint, "");

  return (
    <div className="space-y-6">
      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="mcp-url">
        <h2 id="mcp-url" className="text-sm font-semibold text-foreground">
          Server manzili (MCP, Streamable HTTP)
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface px-3 py-2 text-sm" data-testid="mcp-endpoint">
            {meta.endpoint}
          </code>
          <CopyButton text={meta.endpoint} label="Manzilni nusxalash" />
        </div>
        <p className="text-xs text-muted">
          Shu manzil yetarli: AI mijoz OAuth orqali o&apos;zi ro&apos;yxatdan o&apos;tadi, sizni ruxsat sahifasiga yuboradi va tokenni o&apos;zi oladi. Token bu yerda &quot;Tokenlar&quot; ro&apos;yxatida ko&apos;rinadi va istalgan vaqtda bekor qilinadi.
        </p>
        {!meta.enabled && <Notice tone="warning">MCP o&apos;chirilgan (MCP_DISABLED): ulanish ruxsat sahifasida rad etiladi.</Notice>}
        {!meta.me.canManage && <Notice tone="warning">Ruxsat berish uchun workspace egasi yoki administrator bo&apos;lish kerak.</Notice>}
      </section>

      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="mcp-clients">
        <h2 id="mcp-clients" className="text-sm font-semibold text-foreground">
          Qanday ulanadi
        </h2>
        <ul className="divide-y divide-border">
          {CLIENTS.map((c) => (
            <li key={c.key} className="py-2">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium text-foreground"
                aria-expanded={open === c.key}
                onClick={() => setOpen(open === c.key ? "" : c.key)}
              >
                {c.title}
                <span className="label-mono text-[10px] text-muted">{open === c.key ? "YOPISH" : "OCHISH"}</span>
              </button>
              {open === c.key && (
                <div className="mt-2 space-y-2">
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
                    {c.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  {"command" in c && c.command && (
                    <div className="space-y-1">
                      <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-3 text-xs">{snippets.claudeCodeOauth}</pre>
                      <CopyButton text={snippets.claudeCodeOauth} label="Buyruqni nusxalash" />
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {meta.oauth && (
          <p className="text-xs text-muted">
            Texnik: OAuth 2.1 (PKCE), discovery <code className="break-all">{meta.oauth.authorizationServer}</code>, ruxsat sahifasi <code className="break-all">{meta.oauth.authorize}</code>.
          </p>
        )}
      </section>

      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="mcp-connected">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="mcp-connected" className="text-sm font-semibold text-foreground">
            Ulangan AI mijozlar ({connected.length})
          </h2>
          <button type="button" className={secondaryButton} onClick={onManage}>
            Tokenlarni boshqarish
          </button>
        </div>
        {connected.length === 0 ? (
          <EmptyState title="Hali hech kim ulanmagan" body="AI mijozga yuqoridagi manzilni bering; ruxsat bergandan keyin u shu yerda ko'rinadi." />
        ) : (
          <ul className="space-y-2">
            {connected.map((t) => {
              const state = tokenState(t);
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {t.name} <span className="label-mono ml-1 text-[10px] text-muted">{t.scope}</span>
                      {t.scope === "WRITE" && <span className="label-mono ml-1 text-[10px] text-muted">{t.requireHumanApproval ? "INSON TASDIG'I" : "AI O'ZI TASDIQLAYDI"}</span>}
                    </p>
                    <p className="text-xs text-muted">
                      ulandi {formatDateTime(t.createdAt)} · oxirgi ishlatilgan: {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "hech qachon"}
                      {t.expiresAt ? ` · token ${formatDateTime(t.expiresAt)} gacha (o'zi yangilanadi)` : ""}
                    </p>
                  </div>
                  <Pill tone={state.tone}>{state.label}</Pill>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
