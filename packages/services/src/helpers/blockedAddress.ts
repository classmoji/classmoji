/**
 * blockedAddress.ts — is this IP address one we must never connect to?
 *
 * Moved out of `@classmoji/tasks`' safeUrlFetch (which still re-exports it) so
 * the MCP's render browser applies the SAME rule to the requests a rendered
 * deck or page makes. Pure: no DNS, no I/O — callers resolve and then ask.
 */

import { isIP } from 'node:net';

/**
 * IPv4 ranges that are not publicly routable, or that reach something on or
 * next to our own host. `[network, prefixLength]`, network as dotted quad.
 * Sources: RFC 6890 special-purpose registry, plus 169.254.169.254 (cloud
 * metadata) which sits inside the link-local /16.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network", incl. 0.0.0.0 (unspecified — Linux routes it to localhost)
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (shared address space)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
];

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    // Strict decimal only. `isIP` has already rejected octal/hex forms, and
    // the WHATWG URL parser normalises those to dotted decimal anyway.
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const BLOCKED_V4_NUMERIC = BLOCKED_V4.map(([net, bits]) => {
  const base = parseIPv4(net);
  if (base === null) throw new Error(`safeUrlFetch: malformed range ${net}`);
  // Computed with arithmetic rather than `<<`, which is signed 32-bit in JS.
  const size = 2 ** (32 - bits);
  return { base, size };
});

function isBlockedV4(n: number): boolean {
  return BLOCKED_V4_NUMERIC.some(({ base, size }) => n >= base && n < base + size);
}

/**
 * Parse an IPv6 address into 8 16-bit groups. Handles `::` compression and a
 * trailing embedded dotted quad (`::ffff:1.2.3.4`). Returns null for anything
 * it does not understand, which the caller treats as blocked.
 */
function parseIPv6(ip: string): number[] | null {
  let s = ip;
  // Rewrite a trailing dotted quad as two hex groups, then parse uniformly.
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    const hi = Math.floor(v4 / 65536).toString(16);
    const lo = (v4 % 65536).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || rest === null) return null;
  const explicit = head.length + rest.length;
  if (halves.length === 1) return explicit === 8 ? head : null;
  if (explicit > 7) return null;
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest];
}

/** The IPv4 address embedded in groups 6–7 of an IPv6 address. */
function embeddedV4(g: number[], from = 6): number {
  return g[from] * 65536 + g[from + 1];
}

function isBlockedV6(g: number[]): boolean {
  const allZeroUpTo = (n: number) => g.slice(0, n).every(x => x === 0);

  // ::ffff:0:0/96 — IPv4-mapped. The socket really talks IPv4, to the
  // embedded address, so the IPv4 rules decide.
  if (allZeroUpTo(5) && g[5] === 0xffff) return isBlockedV4(embeddedV4(g));
  // 64:ff9b::/96 — well-known NAT64 prefix; the translator forwards to the
  // embedded IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return isBlockedV4(embeddedV4(g));
  }
  // 2002::/16 — 6to4; groups 1–2 carry the IPv4 address of the site.
  if (g[0] === 0x2002) return isBlockedV4(embeddedV4(g, 1));

  // Everything below is an ALLOWLIST: only 2000::/3 is global unicast. That
  // single test excludes ::, ::1, ::/96, 100::/64, 64:ff9b:1::/48, fc00::/7
  // (incl. fd00:ec2::254 metadata), fe80::/10, ff00::/8 and every future
  // special range outside it, without having to enumerate them.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  // Carve-outs inside 2000::/3.
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo tunnelling
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation (RFC 9637)
  return false;
}

/**
 * True when `ip` must not be connected to: private, loopback, link-local,
 * CGNAT, metadata, unspecified, multicast, broadcast, documentation or
 * otherwise reserved. Anything that is not a parseable IP literal, and any
 * IPv6 address carrying a zone id (`fe80::1%eth0`), is blocked — fail closed.
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (bare.includes('%')) return true;
  const family = isIP(bare);
  if (family === 4) {
    const n = parseIPv4(bare);
    return n === null ? true : isBlockedV4(n);
  }
  if (family === 6) {
    const g = parseIPv6(bare);
    return g === null ? true : isBlockedV6(g);
  }
  return true;
}

