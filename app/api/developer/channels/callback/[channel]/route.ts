import type { NextRequest } from "next/server";
import { flashRedirect } from "@/lib/developer/flash-server";
import { FACEBOOK_SCOPES, facebookPagesFromCode, subscribePage } from "@/lib/channels/facebook";
import { THREADS_SCOPES, threadsTokenFromCode } from "@/lib/channels/threads";
import { PlanLimitError, assertChannelSlots } from "@/lib/billing/limits";
import { prisma } from "@/lib/db/client";
import { putCredential } from "@/lib/channels/vault";
import { youtubeTokenFromCode } from "@/lib/channels/youtube";
import { requireDeveloper } from "@/lib/developer/access";
import { getBaseUrl } from "@/lib/env";
import { verifyOAuthState } from "@/lib/meta/oauth";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ channel: string }> };

/** Page tasks that let us publish or answer; a Page with none of them is not stored. */
const USEFUL_TASKS = new Set(["CREATE_CONTENT", "MODERATE", "MANAGE", "MESSAGING"]);
const CHANNEL_NAME: Record<string, string> = { facebook: "Facebook", threads: "Threads", youtube: "YouTube" };

/**
 * OAuth callback of Facebook / Threads / YouTube. The signed state binds the
 * flow to the workspace that started it, and that must still be the
 * signed-in one. Tokens go straight into the vault, never into the URL or a log.
 */
export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { channel } = await params;
  // The outcome travels in a one-shot cookie, never in the URL (nobody can edit the wording).
  const back = (query: Record<string, string>) => {
    if (query.error) return flashRedirect("/developer/channels", { tone: "error", text: query.error });
    const name = CHANNEL_NAME[query.connected] ?? query.connected;
    return flashRedirect("/developer/channels", { tone: query.warning ? "warning" : "success", text: `${name} ulandi (${query.count ?? 1})${query.warning ? ` — ${query.warning}` : ""}` });
  };

  const search = request.nextUrl.searchParams;
  const state = verifyOAuthState(search.get("state"));
  if (!state || state.workspaceId !== auth.ctx.workspaceId) return back({ error: "Ulanish sessiyasi eskirgan — qaytadan urinib ko'ring" });
  const code = search.get("code");
  if (!code) return back({ error: search.get("error_description") ?? search.get("error") ?? "Ruxsat berilmadi" });

  const workspaceId = auth.ctx.workspaceId;
  /** Tariff channel count (phase 8): reconnecting a known account is free. */
  const slots = async (channelId: string, ids: string[]) => {
    const known = await prisma.channelCredential.findMany({ where: { workspaceId, channel: channelId, externalAccountId: { in: ids }, status: { not: "REVOKED" } }, select: { externalAccountId: true } });
    await assertChannelSlots(workspaceId, ids.length - known.length);
  };
  const redirectUri = `${getBaseUrl()}/api/developer/channels/callback/${channel}`;
  try {
    if (channel === "facebook") {
      const pages = (await facebookPagesFromCode(code, redirectUri)).filter((p) => p.tasks.length === 0 || p.tasks.some((t) => USEFUL_TASKS.has(t)));
      if (pages.length === 0) return back({ error: "Boshqaradigan Facebook sahifa topilmadi. Ulash oynasida sahifani belgilang va akkaunt sahifada to'liq boshqaruv huquqiga ega ekanini tekshiring." });
      await slots("facebook", pages.map((p) => p.id));
      let unsubscribed = 0;
      for (const page of pages) {
        await putCredential({ workspaceId, channel: "facebook", externalAccountId: page.id, label: page.name, scopes: FACEBOOK_SCOPES, secret: { accessToken: page.accessToken, extra: { pageName: page.name, tasks: page.tasks } } });
        await subscribePage(page.id, page.accessToken).catch(() => unsubscribed++);
      }
      return back({ connected: "facebook", count: String(pages.length), ...(unsubscribed ? { warning: `${unsubscribed} ta sahifa webhook'ga obuna bo'lmadi` } : {}) });
    }
    if (channel === "threads") {
      const account = await threadsTokenFromCode(code, redirectUri);
      await slots("threads", [account.userId]);
      await putCredential({ workspaceId, channel: "threads", externalAccountId: account.userId, label: account.username ? `@${account.username}` : null, scopes: THREADS_SCOPES, expiresAt: account.expiresAt, secret: { accessToken: account.accessToken, extra: { username: account.username } } });
      return back({ connected: "threads", count: "1" });
    }
    if (channel === "youtube") {
      const account = await youtubeTokenFromCode(code, redirectUri);
      await slots("youtube", [account.channelId]);
      await putCredential({ workspaceId, channel: "youtube", externalAccountId: account.channelId, label: account.title, scopes: account.scopes, expiresAt: account.expiresAt, secret: { accessToken: account.accessToken, refreshToken: account.refreshToken, extra: { title: account.title } } });
      return back({ connected: "youtube", count: "1" });
    }
    return back({ error: "Noma'lum kanal" });
  } catch (error) {
    if (error instanceof PlanLimitError) return back({ error: error.message });
    return back({ error: error instanceof Error ? error.message.slice(0, 200) : "Ulanmadi" });
  }
}
