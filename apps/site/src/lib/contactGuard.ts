// The contact form's guards (src/pages/api/contact.ts): who is asking, how
// often, and how much they may send. No Astro or Cloudflare imports, so the
// tests run them directly; the route passes in its runtime and bindings.

/** Where the route runs: Fly's Node server, or a Cloudflare Worker (workerd). */
export type Runtime = 'node' | 'workerd';

/**
 * The largest form body accepted, as the Node adapter's `bodySizeLimit` in
 * astro.config.mjs. The form's largest post is about 50 KB (every field at
 * its maxlength in 3-byte characters, URL-encoded).
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The address a request came from.
 *
 * - workerd: `cf-connecting-ip`, which Cloudflare sets on every request and
 *   overwrites if the client sent one. Never Astro's clientAddress or
 *   X-Forwarded-For: with `security.allowedDomains` set, Astro can trust an
 *   X-Forwarded-For the client wrote.
 * - Node (Fly): `fly-client-ip`, which Fly's proxy sets, else the socket's
 *   address.
 *
 * Missing → 'unknown', one shared bucket.
 */
export function clientIp(
  runtime: Runtime,
  headers: Headers,
  clientAddress: () => string | undefined,
): string {
  if (runtime === 'workerd') return headers.get('cf-connecting-ip')?.trim() || 'unknown';
  const fly = headers.get('fly-client-ip')?.trim();
  if (fly) return fly;
  try {
    return clientAddress() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The rate-limit key for an address: IPv4 as is, IPv6 by its /64 (one
 * subscriber usually holds a whole /64, so per-address keys would let them
 * rotate past the limit). IPv4-mapped IPv6 counts as the IPv4 address.
 */
export function limiterKey(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!address.includes(':')) return address || 'unknown';

  const groups = expandIpv6(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every(g => g === '0') && groups[5] === 'ffff') {
    const [high, low] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** The eight groups of an IPv6 address, each without leading zeros; null if it is not one. */
function expandIpv6(address: string): string[] | null {
  let text = address;
  // A trailing dotted IPv4 part counts as the last two groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    if ([a, b, c, d].some(n => n > 255)) return null;
    text = text.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map(g => parseInt(g, 16).toString(16));
}

/**
 * A few messages per key per hour, in memory: per Node machine on Fly (the
 * site runs on one), per isolate on Workers (where the bindings below add the
 * shared per-minute limits). Resets on deploy; it only has to stop casual floods.
 */
export function createMemoryLimiter({ max = 5, windowMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const recent = new Map<string, number[]>();
  return {
    /** Records the attempt and reports whether the key is over its limit. */
    limited(key: string): boolean {
      const at = now();
      const hits = (recent.get(key) ?? []).filter(t => at - t < windowMs);
      if (hits.length >= max) {
        recent.set(key, hits);
        return true;
      }
      hits.push(at);
      recent.set(key, hits);
      return false;
    },
  };
}

export type MemoryLimiter = ReturnType<typeof createMemoryLimiter>;

/** A Workers rate-limit binding (wrangler.jsonc `ratelimits`). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The bindings the contact route reads, as `env` from `cloudflare:workers` gives them. */
export interface ContactBindings {
  /** 3 a minute per address key. */
  CONTACT_RATE_LIMIT?: RateLimitBinding;
  /** 10 a minute for the whole site, under the key `all`. */
  CONTACT_RATE_LIMIT_GLOBAL?: RateLimitBinding;
}

/**
 * Whether this message is over a limit.
 *
 * Node: the in-memory hourly limit only. workerd: that limit too, then the
 * per-address binding, then the global binding. A binding that is missing or
 * throws is logged and skipped, which leaves the in-memory limit: never
 * unlimited.
 */
export async function overLimit({
  runtime,
  key,
  memory,
  bindings,
  log = console.error,
}: {
  runtime: Runtime;
  key: string;
  memory: MemoryLimiter;
  bindings?: ContactBindings;
  log?: (...args: unknown[]) => void;
}): Promise<boolean> {
  if (memory.limited(key)) return true;
  if (runtime !== 'workerd') return false;

  const checks: [string, RateLimitBinding | undefined, string][] = [
    ['CONTACT_RATE_LIMIT', bindings?.CONTACT_RATE_LIMIT, key],
    ['CONTACT_RATE_LIMIT_GLOBAL', bindings?.CONTACT_RATE_LIMIT_GLOBAL, 'all'],
  ];
  for (const [name, binding, bindingKey] of checks) {
    if (!binding || typeof binding.limit !== 'function') {
      log(`[contact] The ${name} binding is missing; only the in-memory limit applies.`);
      continue;
    }
    try {
      const { success } = await binding.limit({ key: bindingKey });
      if (!success) return true;
    } catch (error) {
      log(`[contact] The ${name} binding failed; only the in-memory limit applies.`, error);
    }
  }
  return false;
}

/** The body, if it fits in `max` bytes; 'too-large' otherwise. */
export async function readCappedBody(
  request: Request,
  max = MAX_BODY_BYTES,
): Promise<Uint8Array<ArrayBuffer> | 'too-large'> {
  // A declared length over the cap is refused before anything is read.
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > max) return 'too-large';

  // The length can be missing (chunked) or wrong, so the read is capped too.
  const body = request.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return 'too-large';
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The form fields of a capped body (url-encoded or multipart), as `request.formData()` would read them. */
export function parseForm(bytes: Uint8Array<ArrayBuffer>, contentType: string | null): Promise<FormData> {
  return new Response(bytes, { headers: contentType ? { 'content-type': contentType } : {} }).formData();
}
