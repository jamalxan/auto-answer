import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LogoMark from "@/components/logo-mark";
import { getDeveloperSession } from "@/lib/developer/auth";
import { isMcpEnabled, MAX_TOKENS_PER_WORKSPACE, MCP_OFF_MESSAGE } from "@/lib/mcp/config";
import { ACCESS_TOKEN_TTL_MS, AUTHORIZE_PATH, parseAuthorizeRequest, REFRESH_TOKEN_TTL_MS } from "@/lib/mcp/oauth";
import { approveMcpAuthorizationAction, denyMcpAuthorizationAction } from "@/lib/mcp/oauth-actions";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const metadata: Metadata = { title: "AI mijozga ruxsat", robots: { index: false, follow: false } };

export const dynamic = "force-dynamic";

/**
 * ETAP 12 — the OAuth consent screen. An MCP client (Claude.ai, Claude Desktop,
 * ChatGPT, Claude Code, …) sends the person here; after the developer login and
 * the app session, a workspace OWNER / ADMIN picks the scope and approves. The
 * code goes back to the client, which exchanges it for a token at /api/mcp/oauth/token.
 */
export default async function McpAuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "ui_error") continue;
    const v = Array.isArray(value) ? value[0] : value;
    if (typeof v === "string") query.set(key, v);
  }
  const full = `${AUTHORIZE_PATH}?${query.toString()}`;

  if (!(await getDeveloperSession())) redirect(`/developer/login?next=${encodeURIComponent(full)}`);
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) redirect(`/login?callbackUrl=${encodeURIComponent(full)}`);

  const parsed = await parseAuthorizeRequest(query);
  if (!parsed.ok && parsed.redirectTo) redirect(parsed.redirectTo);

  const uiError = typeof params.ui_error === "string" ? params.ui_error.slice(0, 300) : null;
  const canManage = canManageWorkspace(ctx.role);
  const activeTokens = await prisma.mcpToken.count({ where: { workspaceId: ctx.workspaceId, revokedAt: null } });
  const enabled = isMcpEnabled();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-10 text-foreground">
      <div className="w-full max-w-md">
        <div className="text-center">
          <span className="inline-flex items-center gap-2.5 font-display text-lg font-extrabold tracking-tight text-foreground">
            <LogoMark />
            SocialAuto
          </span>
          <h1 className="mt-4 font-display text-2xl font-extrabold text-foreground">AI mijozga ruxsat berish</h1>
          <p className="mt-2 text-sm text-muted">MCP orqali ulanish (Claude, ChatGPT va boshqalar).</p>
        </div>

        {!parsed.ok ? (
          <section className="mt-6 rounded-xl border border-error/40 bg-error/10 p-4 text-sm" role="alert">
            <p className="font-semibold text-error">Ulanish so&apos;rovi noto&apos;g&apos;ri</p>
            <p className="mt-1 text-foreground">{parsed.description}</p>
            <p className="mt-2 text-xs text-muted">
              Texnik kod: <code>{parsed.error}</code>. AI mijozda ulanishni qaytadan boshlang; muammo takrorlansa /developer/mcp da tokenni qo&apos;lda yarating.
            </p>
          </section>
        ) : (
          <section className="panel mt-6 space-y-5 rounded-xl p-5">
            <div className="rounded-lg border border-border bg-surface px-4 py-3 text-sm">
              <p>
                <strong className="text-foreground">{parsed.request.clientName}</strong>
                {" "}quyidagi workspace&apos;ga ulanmoqchi:
              </p>
              <p className="mt-1 font-semibold text-foreground">{ctx.workspace.name}</p>
              <p className="mt-1 break-all text-xs text-muted">Qaytish manzili: {parsed.request.redirectUri}</p>
            </div>

            {uiError && (
              <p className="rounded border border-error/40 bg-error/10 p-3 text-sm text-error" role="alert">
                {uiError}
              </p>
            )}
            {!enabled && <p className="rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning">{MCP_OFF_MESSAGE}</p>}
            {!canManage && (
              <p className="rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                Ruxsat berish uchun workspace egasi yoki administrator bo&apos;lish kerak. Sizning rolingiz: {ctx.role}.
              </p>
            )}
            {canManage && activeTokens >= MAX_TOKENS_PER_WORKSPACE && (
              <p className="rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                Faol tokenlar {MAX_TOKENS_PER_WORKSPACE} ta — shu client avval ulangan bo&apos;lsa eski tokeni almashtiriladi, aks holda /developer/mcp da bittasini bekor qiling.
              </p>
            )}

            <form action={approveMcpAuthorizationAction} className="space-y-4">
              <input type="hidden" name="q" value={query.toString()} />
              <fieldset className="space-y-2" disabled={!canManage || !enabled}>
                <legend className="text-sm font-semibold text-foreground">Ruxsat darajasi</legend>
                <label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <input type="radio" name="scope" value="READ" defaultChecked={parsed.request.requestedScope === "READ"} className="mt-1" />
                  <span>
                    <span className="font-medium text-foreground">Faqat o&apos;qish (READ)</span>
                    <span className="block text-xs text-muted">Kampaniya, flow, lid, analitika va diagnostikani o&apos;qiydi. Hech narsani o&apos;zgartira olmaydi.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <input type="radio" name="scope" value="WRITE" defaultChecked={parsed.request.requestedScope === "WRITE"} className="mt-1" />
                  <span>
                    <span className="font-medium text-foreground">O&apos;qish + yozish (WRITE)</span>
                    <span className="block text-xs text-muted">
                      O&apos;zgarishlarni taklif qiladi (kampaniya, flow qoralamasi, teg, bosqich). Hech narsa mijozlarga yetib bormaydi: nashr qilish faqat ilovada, inson tomonidan.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 pt-1 text-sm text-foreground">
                  <input type="checkbox" name="humanApproval" value="on" defaultChecked className="mt-1" />
                  <span>
                    Har bir yozishni men tasdiqlayman (tavsiya etiladi)
                    <span className="block text-xs text-muted">
                      WRITE uchun: AI faqat preview beradi, amalni /developer/mcp &quot;Amallar jurnali&quot;da siz tasdiqlaysiz. Belgini olib tashlasangiz AI preview kodi bilan o&apos;zi tasdiqlaydi.
                    </span>
                  </span>
                </label>
              </fieldset>
              <p className="text-xs text-muted">
                Token {Math.round(ACCESS_TOKEN_TTL_MS / 86_400_000)} kun amal qiladi va mijoz uni o&apos;zi yangilab turadi ({Math.round(REFRESH_TOKEN_TTL_MS / 86_400_000)} kungacha). Istalgan vaqtda /developer/mcp da bekor qilasiz.
              </p>
              <button
                type="submit"
                disabled={!canManage || !enabled}
                className="label-mono w-full rounded bg-accent px-4 py-2.5 text-xs font-bold text-background transition hover:bg-accent-hover disabled:opacity-50"
              >
                Ruxsat berish
              </button>
            </form>
            <form action={denyMcpAuthorizationAction}>
              <input type="hidden" name="q" value={query.toString()} />
              <button type="submit" className="label-mono w-full rounded border border-border px-4 py-2.5 text-xs font-bold text-foreground transition hover:bg-surface">
                Rad etish
              </button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
