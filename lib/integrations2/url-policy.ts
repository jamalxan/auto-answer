/**
 * ETAP 8 — outbound URL policy, applied when a webhook is saved **and**
 * before every send (DNS can change between the two).
 *
 *   https only · no userinfo · port 443 / 8443 · no internal hostnames
 *   (lib/integrations/net.ts) · every DNS-resolved address public
 *
 * `OUTBOUND_WEBHOOK_ALLOW_HOSTS` (comma separated, exact or `.suffix`) skips
 * the port and address checks for a host; `OUTBOUND_WEBHOOK_DENY_HOSTS` wins
 * over everything. The resolver is injectable so tests never touch DNS.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isInternalHostname, isPrivateAddress } from "@/lib/integrations/net";

export type UrlPolicyCode =
  | "invalid_url"
  | "scheme"
  | "userinfo"
  | "port"
  | "internal_host"
  | "denied_host"
  | "private_address"
  | "unresolvable";

export type UrlPolicyResult =
  | { ok: true; host: string; url: string; allowlisted: boolean }
  | { ok: false; code: UrlPolicyCode; reason: string; host?: string };

export const URL_POLICY_REASONS: Record<UrlPolicyCode, string> = {
  invalid_url: "URL noto'g'ri formatda",
  scheme: "Faqat https:// manzillar qabul qilinadi",
  userinfo: "URL ichida login yoki parol bo'lishi mumkin emas",
  port: "Faqat 443 yoki 8443 portlarga yuborish mumkin",
  internal_host: "Ichki yoki lokal manzillarga yuborib bo'lmaydi",
  denied_host: "Bu host taqiqlangan ro'yxatda",
  private_address: "Host xususiy (private) IP manzilga yo'naltiriladi",
  unresolvable: "Host nomi DNS orqali topilmadi",
};

export const ALLOWED_PORTS = ["", "443", "8443"] as const;

export type HostResolver = (host: string) => Promise<string[]>;

export interface UrlPolicyOptions {
  resolve?: HostResolver;
  allowHosts?: string[];
  denyHosts?: string[];
}

/** `lookup(host, { all: true })` → plain address strings. */
export const defaultResolver: HostResolver = async (host) => {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
};

// ─── Host lists ───────────────────────────────────────────────────────────────

function parseHostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function readAllowHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseHostList(env.OUTBOUND_WEBHOOK_ALLOW_HOSTS);
}

export function readDenyHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseHostList(env.OUTBOUND_WEBHOOK_DENY_HOSTS);
}

/** `example.com` matches exactly; `.example.com` / `*.example.com` match the host and every subdomain. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().replace(/^\*/, "").replace(/\.$/, "");
  if (!p) return false;
  if (p.startsWith(".")) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

export function hostInList(host: string, list: string[] | undefined): boolean {
  return (list ?? []).some((pattern) => hostMatches(host, pattern));
}

// ─── Policy ───────────────────────────────────────────────────────────────────

function fail(code: UrlPolicyCode, host?: string): UrlPolicyResult {
  return { ok: false, code, reason: URL_POLICY_REASONS[code], host };
}

export async function assertOutboundUrl(rawUrl: string, options: UrlPolicyOptions = {}): Promise<UrlPolicyResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return fail("invalid_url");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

  if (url.protocol !== "https:") return fail("scheme", host);
  if (url.username || url.password) return fail("userinfo", host);

  const denyHosts = options.denyHosts ?? readDenyHosts();
  if (hostInList(host, denyHosts)) return fail("denied_host", host);

  const allowHosts = options.allowHosts ?? readAllowHosts();
  const allowlisted = hostInList(host, allowHosts);

  if (!allowlisted && !(ALLOWED_PORTS as readonly string[]).includes(url.port)) return fail("port", host);
  if (allowlisted) return { ok: true, host, url: url.toString(), allowlisted: true };

  if (isInternalHostname(host)) return fail("internal_host", host);
  if (isIP(host)) return { ok: true, host, url: url.toString(), allowlisted: false }; // public literal, nothing to resolve

  let addresses: string[];
  try {
    addresses = await (options.resolve ?? defaultResolver)(host);
  } catch {
    return fail("unresolvable", host);
  }
  if (addresses.length === 0) return fail("unresolvable", host);
  if (addresses.some((a) => isPrivateAddress(a))) return fail("private_address", host);

  return { ok: true, host, url: url.toString(), allowlisted: false };
}

// ─── Preset hints ─────────────────────────────────────────────────────────────

export type UrlPreset = "WEBHOOK" | "MAKE" | "ZAPIER";

/** Make: hook.<region>.make.com/<token>; Zapier: hooks.zapier.com/hooks/catch/<account>/<hook>/. */
export const MAKE_HOST_RE = /^hook(\.[a-z0-9-]+)?\.make\.com$/i;
export const ZAPIER_HOST = "hooks.zapier.com";
export const ZAPIER_PATH_RE = /^\/hooks\/catch\/[^/]+\/[^/]+\/?$/;

/**
 * A warning (not a rejection) when a Make / Zapier URL does not look like a
 * webhook of that service — e.g. a Zapier dashboard link pasted by mistake.
 */
export function presetHint(rawUrl: string, preset: UrlPreset): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (preset === "MAKE") {
    if (!MAKE_HOST_RE.test(host)) {
      return "Make webhook manzili odatda https://hook.eu1.make.com/... ko'rinishida bo'ladi. Scenario → Webhooks → Custom webhook'dan nusxa oling.";
    }
    if (url.pathname.length < 10) return "Make webhook manziliga token qismi yetishmayapti.";
    return null;
  }
  if (preset === "ZAPIER") {
    if (host !== ZAPIER_HOST) {
      return "Zapier Catch Hook manzili https://hooks.zapier.com/hooks/catch/... ko'rinishida bo'ladi. Zap → Webhooks by Zapier → Catch Hook'dan nusxa oling.";
    }
    if (!ZAPIER_PATH_RE.test(url.pathname)) return "Zapier manzili /hooks/catch/<account>/<hook>/ ko'rinishida bo'lishi kerak.";
    return null;
  }
  if (MAKE_HOST_RE.test(host)) return "Bu Make manzili — «Make» turini tanlasangiz maydonlar tayyor keladi.";
  if (host === ZAPIER_HOST) return "Bu Zapier manzili — «Zapier» turini tanlasangiz maydonlar tayyor keladi.";
  return null;
}
