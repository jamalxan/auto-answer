/**
 * SSRF helpers shared by everything that fetches a user-supplied URL
 * (website autofill, Bitrix24 webhooks).
 */

import { isIP } from "node:net";

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Eight 16-bit groups of an IPv6 address, or null if it does not parse. */
function ipv6Groups(address: string): number[] | null {
  let canonical: string;
  try {
    // WHATWG URL canonicalises every spelling (dotted tail, leading zeros,
    // uncompressed) into the same compressed hex form.
    canonical = new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  const [head, tail] = canonical.split("::");
  const parse = (part: string | undefined) =>
    part ? part.split(":").map((g) => parseInt(g, 16)) : [];
  const left = parse(head);
  const right = parse(tail);
  const groups =
    tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * The IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1),
 * IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) or 6to4 (2002::/16)
 * IPv6 address, or null.
 */
export function embeddedIPv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (!g) return null;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}

/** True for loopback, private, link-local and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const kind = isIP(bare);
  if (kind === 4) return isPrivateIPv4(bare);
  // Zone ids (fe80::1%eth0) only exist on link-local addresses.
  if (bare.includes("%")) return true;
  const g = ipv6Groups(bare);
  if (!g) return kind === 6; // unparseable IPv6: fail closed
  const embedded = embeddedIPv4(bare);
  if (embedded) return isPrivateIPv4(embedded);
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g[0] & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/**
 * True when a URL hostname is obviously internal: localhost-style names or an
 * IP literal in a private range. Does not resolve DNS.
 */
export function isInternalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  if (isIP(host)) return isPrivateAddress(host);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  );
}
