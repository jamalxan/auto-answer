import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/automations",
  "/logs",
  "/settings",
  "/assistant",
  "/leads",
  "/integrations",
  "/content",
  "/channels",
  "/ads",
  "/javobai",
  "/comments",
  "/triggers",
  "/flows",
  "/crm",
  "/engagement",
  "/analytics",
  "/content-intel",
  "/telegram",
  "/connectors",
  "/migration",
  "/billing",
  // Developer area: needs the app session too (its modules work on the
  // signed-in workspace); its own login is checked by the pages.
  "/developer",
];

function hasSessionCookie(request: NextRequest): boolean {
  return (
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token") ||
    request.cookies.has("next-auth.session-token") ||
    request.cookies.has("__Secure-next-auth.session-token")
  );
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  const isLogin = pathname === "/login";
  const isAuthenticated = hasSessionCookie(request);

  if (isProtected && !isAuthenticated) {
    const loginUrl = new URL("/login", request.url);
    // Path + query: the MCP consent screen (/developer/mcp/authorize?...) must survive the login round trip.
    loginUrl.searchParams.set("callbackUrl", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (isLogin && isAuthenticated) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/automations/:path*",
    "/logs/:path*",
    "/settings/:path*",
    "/assistant/:path*",
    "/leads/:path*",
    "/integrations/:path*",
    "/content/:path*",
    "/channels/:path*",
    "/ads/:path*",
    "/javobai/:path*",
    "/comments/:path*",
    "/triggers/:path*",
    "/flows/:path*",
    "/crm/:path*",
    "/engagement/:path*",
    "/analytics/:path*",
    "/content-intel/:path*",
    "/telegram/:path*",
    "/connectors/:path*",
    "/migration/:path*",
    "/billing/:path*",
    "/developer/:path*",
    "/login",
  ],
};
