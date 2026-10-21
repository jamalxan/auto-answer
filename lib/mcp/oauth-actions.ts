"use server";

/**
 * ETAP 12 — the consent screen's two buttons (/developer/mcp/authorize). The
 * authorization request is re-parsed from the ORIGINAL query string carried in a
 * hidden field, so a tampered form can only ever approve what the page showed.
 * Guards: developer login + app session + OWNER / ADMIN (a token is a credential).
 */

import { redirect } from "next/navigation";
import { getDeveloperSession } from "@/lib/developer/auth";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { isMcpEnabled } from "./config";
import { McpServiceError } from "./errors";
import { AUTHORIZE_PATH, denyAuthorization, issueAuthorizationCode, parseAuthorizeRequest } from "./oauth";

/** Only a same-origin /developer/mcp/authorize?… query is ever re-used; anything else is dropped. */
function queryOf(formData: FormData): URLSearchParams | null {
  const raw = formData.get("q");
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192 || raw.includes("//") || raw.includes("\\")) return null;
  return new URLSearchParams(raw);
}

function backToPage(query: URLSearchParams, error: string): never {
  const next = new URLSearchParams(query);
  next.set("ui_error", error);
  redirect(`${AUTHORIZE_PATH}?${next.toString()}`);
}

async function guard(query: URLSearchParams) {
  const full = `${AUTHORIZE_PATH}?${query.toString()}`;
  if (!(await getDeveloperSession())) redirect(`/developer/login?next=${encodeURIComponent(full)}`);
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) redirect(`/login?callbackUrl=${encodeURIComponent(full)}`);
  return ctx;
}

export async function approveMcpAuthorizationAction(formData: FormData): Promise<void> {
  const query = queryOf(formData);
  if (!query) redirect(AUTHORIZE_PATH);
  const ctx = await guard(query);
  const parsed = await parseAuthorizeRequest(query);
  if (!parsed.ok) {
    if (parsed.redirectTo) redirect(parsed.redirectTo);
    backToPage(query, parsed.description);
  }
  if (!canManageWorkspace(ctx.role)) redirect(denyAuthorization(parsed.request, "access_denied").redirectTo);
  if (!isMcpEnabled()) redirect(denyAuthorization(parsed.request, "temporarily_unavailable").redirectTo);

  const scope = formData.get("scope") === "WRITE" ? "WRITE" : "READ";
  const requireHumanApproval = formData.get("humanApproval") !== "off";
  let redirectTo: string;
  try {
    ({ redirectTo } = await issueAuthorizationCode(parsed.request, { workspaceId: ctx.workspaceId, userId: ctx.userId, scope, requireHumanApproval }));
  } catch (error) {
    if (error instanceof McpServiceError) backToPage(query, error.message);
    console.error("[MCP OAuth] consent failed:", error instanceof Error ? error.name : typeof error);
    backToPage(query, "Kutilmagan xato — birozdan keyin qayta urinib ko'ring");
  }
  redirect(redirectTo);
}

export async function denyMcpAuthorizationAction(formData: FormData): Promise<void> {
  const query = queryOf(formData);
  if (!query) redirect(AUTHORIZE_PATH);
  await guard(query);
  const parsed = await parseAuthorizeRequest(query);
  if (!parsed.ok) {
    if (parsed.redirectTo) redirect(parsed.redirectTo);
    redirect("/developer/mcp");
  }
  redirect(denyAuthorization(parsed.request).redirectTo);
}
