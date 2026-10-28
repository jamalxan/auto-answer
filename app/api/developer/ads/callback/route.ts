import type { NextRequest } from "next/server";
import { adsTokenFromCode, listAdAccounts } from "@/lib/ads/meta-ads";
import { saveAdAccount } from "@/lib/ads/service";
import { requireDeveloper } from "@/lib/developer/access";
import { flashRedirect } from "@/lib/developer/flash-server";
import { getBaseUrl } from "@/lib/env";
import { verifyOAuthState } from "@/lib/meta/oauth";

export const dynamic = "force-dynamic";

/** Meta account_status 1 = ACTIVE; disabled / unsettled accounts are not stored. */
const ACTIVE = 1;

export async function GET(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  // Outcome goes in a one-shot cookie, not the URL.
  const back = (query: Record<string, string>) =>
    query.error
      ? flashRedirect("/developer/ads", { tone: "error", text: query.error })
      : flashRedirect("/developer/ads", { tone: "success", text: `${query.connected} ta reklama akkaunti ulandi — endi chegaralarni belgilang` });
  const search = request.nextUrl.searchParams;
  const state = verifyOAuthState(search.get("state"));
  if (!state || state.workspaceId !== auth.ctx.workspaceId) return back({ error: "Ulanish sessiyasi eskirgan — qaytadan urinib ko'ring" });
  const code = search.get("code");
  if (!code) return back({ error: search.get("error_description") ?? "Ruxsat berilmadi" });
  try {
    const token = await adsTokenFromCode(code, `${getBaseUrl()}/api/developer/ads/callback`);
    const accounts = (await listAdAccounts(token)).filter((a) => a.status === ACTIVE);
    if (accounts.length === 0) return back({ error: "Faol reklama akkaunti topilmadi" });
    for (const account of accounts) await saveAdAccount(auth.ctx.workspaceId, { adAccountId: account.adAccountId, name: account.name, currency: account.currency, token });
    return back({ connected: String(accounts.length) });
  } catch (error) {
    return back({ error: error instanceof Error ? error.message.slice(0, 200) : "Ulanmadi" });
  }
}
