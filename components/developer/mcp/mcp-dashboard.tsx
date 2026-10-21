"use client";

/**
 * ETAP 12 — MCP / AI control layer, the developer screen: tokens (create / list /
 * revoke), the audit log of proposed writes, a live "try it" call and the tool
 * list. Tokens belong to the workspace you are signed in to (switch workspace in
 * the app to manage another one).
 */

import { ServerOffNotice } from "@/components/developer/server-off";
import { useCallback, useEffect, useRef, useState } from "react";
import { DevBadge, Pill, secondaryButton } from "@/components/developer/ui";
import ActionsLog from "./actions-log";
import ConnectPanel from "./connect-panel";
import { MCP_API, requestJson, type McpMeta, type TokenRow } from "./shared";
import TokenPanel from "./token-panel";
import TryPanel from "./try-panel";

const TABS = [
  { key: "connect", label: "Ulanish" },
  { key: "tokens", label: "Tokenlar" },
  { key: "log", label: "Amallar jurnali" },
  { key: "try", label: "Sinab ko'rish" },
  { key: "tools", label: "Asboblar" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function McpDashboard() {
  const [meta, setMeta] = useState<McpMeta | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [tab, setTab] = useState<TabKey>("connect");
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState("");
  const [logKey, setLogKey] = useState(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const [metaRes, tokensRes] = await Promise.all([requestJson<McpMeta>(`${MCP_API}/meta`), requestJson<TokenRow[]>(`${MCP_API}/tokens`)]);
      if (mine !== seq.current) return;
      if (metaRes.ok) setMeta(metaRes.data);
      else setFailure(metaRes.error);
      if (tokensRes.ok) setTokens(Array.isArray(tokensRes.data) ? tokensRes.data : []);
      else setFailure((prev) => prev ?? tokensRes.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">MCP / AI boshqaruv</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Claude yoki ChatGPT orqali SocialAuto&apos;ni boshqaring: AI mijozga server manzilini bering, u OAuth orqali o&apos;zi ulanadi. O&apos;qish darhol ishlaydi; har bir yozish avval ko&apos;rinish (preview) bilan tasdiqlanadi. Flow nashr qilish bu yerda yo&apos;q.
          </p>
          {meta?.workspace && (
            <p className="mt-1 text-xs text-muted">
              Workspace: <strong className="text-foreground">{meta.workspace.name}</strong> (tokenlar faqat shu workspace uchun)
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {meta && <Pill tone={meta.enabled ? "success" : "error"}>{meta.enabled ? "Yoqilgan" : "O'chirilgan"}</Pill>}
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
        </div>
      </div>

      {failure && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">
          <span className="min-w-0 break-words">{failure}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}
      {meta && !meta.enabled && (
        <ServerOffNotice
          what="MCP o'chirilgan: /api/mcp 503 qaytaradi va yangi token yaratib bo'lmaydi. Tokenlarni ko'rish va bekor qilish ishlayveradi."
          ops={<><code>MCP_DISABLED</code> ni olib tashlab, web&apos;ni qayta ishga tushiring.</>}
        />
      )}

      <nav aria-label="MCP bo'limlari">
        <ul className="flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map((t) => (
            <li key={t.key} className="shrink-0">
              <button
                type="button"
                aria-current={tab === t.key ? "page" : undefined}
                onClick={() => {
                  setTab(t.key);
                  if (t.key === "log") setLogKey((k) => k + 1);
                }}
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === t.key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {!meta ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : tab === "connect" ? (
        <ConnectPanel meta={meta} tokens={tokens} onManage={() => setTab("tokens")} />
      ) : tab === "tokens" ? (
        <TokenPanel meta={meta} tokens={tokens} onChanged={() => void load()} onCreated={setFreshToken} />
      ) : tab === "log" ? (
        <ActionsLog meta={meta} refreshKey={logKey} />
      ) : tab === "try" ? (
        <TryPanel meta={meta} freshToken={freshToken} />
      ) : (
        <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="mcp-tools">
          <h2 id="mcp-tools" className="text-sm font-semibold text-foreground">
            Asboblar ({meta.tools.length})
          </h2>
          <p className="text-xs text-muted">
            Limitlar: daqiqada {meta.limits.ratePerMin} ta so&apos;rov (token uchun), tanasi {Math.round(meta.limits.maxBodyBytes / 1024)} KB gacha, tasdiq {meta.limits.confirmMinutes} daqiqa ichida.
          </p>
          <ul className="space-y-2">
            {meta.tools.map((t) => (
              <li key={t.name} className="rounded-lg border border-border px-3 py-2">
                <p className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs font-semibold text-foreground">{t.name}</span>
                  <span className="label-mono text-[10px] text-muted">{t.scope}</span>
                  {t.kind === "write" && <span className="label-mono text-[10px] text-warning">TASDIQ KERAK</span>}
                </p>
                <p className="mt-0.5 text-xs text-muted">{t.description}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
