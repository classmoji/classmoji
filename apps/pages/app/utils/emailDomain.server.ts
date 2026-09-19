import { Resolver } from 'node:dns/promises';

/**
 * "Can this address's domain actually receive mail?" — asked while the
 * respondent is still filling the form in.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 * The verification link is now minted when somebody leaves the email field, so
 * there is a window of a minute or two — the rest of the form — in which we can
 * still tell them the address is wrong. Today the only feedback is silence
 * followed by a link that never arrives, and the person has no way to tell
 * "I mistyped my domain" from "the mail is slow". A DNS lookup answers the
 * first of those in a few milliseconds and costs nothing.
 *
 * ── ADVISORY, NEVER A GATE ─────────────────────────────────────────────────
 * This never blocks a submission, and that is a deliberate correctness call
 * rather than caution:
 *
 *  - DNS is not authoritative about mail acceptance. A domain with no MX record
 *    is still required by RFC 5321 §5.1 to be tried at its A/AAAA address — the
 *    "implicit MX" rule — so "no MX" genuinely does not mean "no mail". That
 *    case is checked for explicitly below rather than warned about.
 *  - A resolver that is slow, rate-limited, or answering SERVFAIL says nothing
 *    about the domain, and turning a transient network fault into "your address
 *    is wrong" would be worse than saying nothing.
 *  - The address the person typed is the one the response is FILED under. If
 *    this were a gate, a false negative would not be an inconvenience, it would
 *    be a student unable to join a course because of a DNS hiccup.
 *
 * So the strongest thing said here is a warning next to the field, and the
 * submit path never consults it.
 *
 * ── What is NOT done ───────────────────────────────────────────────────────
 * No SMTP connection, no `RCPT TO` probe. That would be the only way to learn
 * whether a MAILBOX exists, it is what mail providers treat as abuse, and it
 * would turn this endpoint into a mailbox-existence oracle for anybody who can
 * type an address. Domain-level DNS is public data about a domain; mailbox
 * existence is not, and the whole forms flow is built to avoid answering it.
 */

/** How long a decided verdict is trusted. Domains do not change MX often. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * The cache ceiling.
 *
 * Domains here are ATTACKER-SUPPLIED — anybody who can reach the fill page can
 * put a fresh string in front of this — so an unbounded map is a slow memory
 * leak with a public trigger. Swept on write like `submissionRate.server.ts`,
 * for the same reason: a timer would keep the event loop alive in test
 * processes that never asked for one.
 */
const CACHE_MAX_ENTRIES = 500;

/** The per-lookup wall clock. Short: this races a person filling in a form. */
const LOOKUP_TIMEOUT_MS = 2_000;

export type DomainVerdict =
  /** Resolves, and something is prepared to accept mail for it. */
  | 'ok'
  /** The domain does not exist, or exists with no way to receive mail at all. */
  | 'no-mail-server'
  /** We could not find out. Reported to nobody — see the note on advisory. */
  | 'unknown';

interface CacheEntry {
  verdict: DomainVerdict;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function remember(domain: string, verdict: DomainVerdict, now: number): void {
  /**
   * `unknown` is NOT cached. It is a statement about the network at one moment,
   * not about the domain, and caching it would turn a two-second blip into an
   * hour of silence for a domain that is genuinely broken.
   */
  if (verdict === 'unknown') return;

  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  // Still over the ceiling after the sweep: drop oldest-inserted first. Map
  // preserves insertion order, so the first key is the least recently added.
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  cache.set(domain, { verdict, at: now });
}

/**
 * The domain half of an address, lowercased — or null if there isn't one.
 *
 * Deliberately strict about what it will hand to a resolver: labels, dots and
 * hyphens, a real TLD, and inside the DNS length limit. Anything else is not a
 * domain we are going to learn something useful about, and refusing early keeps
 * arbitrary caller-supplied strings out of the resolver entirely.
 */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;

  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!domain || domain.length > 253) return null;
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)
  ) {
    return null;
  }
  return domain;
}

/**
 * Ask DNS whether `domain` can receive mail.
 *
 * ── The two-step, and why ENODATA is not enough on its own ─────────────────
 * `resolveMx` fails two ways that mean genuinely different things:
 *
 *  - ENOTFOUND — NXDOMAIN. The domain does not exist. Nothing can be delivered
 *    to it by anyone, which is the confident case and the one a typo produces.
 *  - ENODATA — the domain exists but publishes no MX. This is where the
 *    implicit-MX rule lives: a small domain with only an A record accepts mail
 *    perfectly well. Warning here would be a false positive on a real address,
 *    so the A/AAAA record is checked before saying anything.
 *
 * Everything else — timeout, SERVFAIL, REFUSED — is `unknown` and reported to
 * nobody.
 */
async function lookup(domain: string): Promise<DomainVerdict> {
  /**
   * A fresh resolver per lookup, configured to give up fast.
   *
   * `tries: 1` matters as much as the timeout: the default is four attempts, so
   * a two-second timeout on an unreachable resolver would still be eight
   * seconds of somebody's form waiting on it.
   */
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });

  try {
    const records = await resolver.resolveMx(domain);
    /**
     * A "null MX" (RFC 7505) is a domain saying explicitly that it accepts no
     * mail — a single record with an empty exchange. That is the one MX answer
     * that is still a definite no.
     */
    const usable = records.filter(record => record.exchange && record.exchange !== '.');
    if (usable.length > 0) return 'ok';
    return 'no-mail-server';
  } catch (error) {
    const code = (error as { code?: string }).code;

    if (code === 'ENOTFOUND' || code === 'NXDOMAIN') return 'no-mail-server';

    if (code === 'ENODATA') {
      // Exists, but no MX. Implicit MX: does it have an address record?
      try {
        const a = await resolver.resolve4(domain);
        if (a.length > 0) return 'ok';
      } catch {
        try {
          const aaaa = await resolver.resolve6(domain);
          if (aaaa.length > 0) return 'ok';
        } catch {
          // Fall through: no MX and no address record.
        }
      }
      return 'no-mail-server';
    }

    // Timeout, SERVFAIL, REFUSED, or anything unforeseen. We learned nothing.
    return 'unknown';
  } finally {
    // Release the sockets rather than waiting for GC. A form page can produce
    // one of these per blur.
    try {
      resolver.cancel();
    } catch {
      // Already finished; nothing to cancel.
    }
  }
}

/**
 * The cached, time-boxed verdict for one domain.
 *
 * The outer race is a belt beside the resolver's own brace: `tries`/`timeout`
 * bound the DNS protocol exchange, and this bounds the CALL, so a resolver that
 * wedges for some reason neither option covers still cannot hold a request
 * open. Losing the race yields `unknown`, which is silence.
 */
export async function checkMailDomain(
  domain: string,
  now: number = Date.now()
): Promise<DomainVerdict> {
  const cached = cache.get(domain);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.verdict;

  let timer: NodeJS.Timeout | undefined;
  const verdict = await Promise.race([
    lookup(domain),
    new Promise<DomainVerdict>(resolve => {
      timer = setTimeout(() => resolve('unknown'), LOOKUP_TIMEOUT_MS + 500);
      // Do not hold the process open for this guard.
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);

  remember(domain, verdict, now);
  return verdict;
}

/** Forget every cached verdict. Tests only. */
export function resetMailDomainCache(): void {
  cache.clear();
}

// ─── "Did you mean …?" ──────────────────────────────────────────────────────

/**
 * The domains worth proposing a correction TOWARDS.
 *
 * Short on purpose. A long list makes near-misses collide (`live.com` and
 * `line.com` are one edit apart) and starts proposing a provider the person has
 * never heard of, which is worse than saying nothing. These are the mailbox
 * hosts a student form actually sees, plus whatever domain the instructor
 * restricted the field to — that last one is the highest-value entry by far,
 * because a form that requires `dartmouth.edu` makes `dartmuoth.edu` both very
 * likely and certainly wrong.
 */
const COMMON_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'live.com',
  'me.com',
];

/** Ordinary Levenshtein distance, with an early bail once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowBest) rowBest = value;
    }
    // Every distance from here on is at least `rowBest`, so once the whole row
    // is past the ceiling the answer cannot come back under it.
    if (rowBest > max) return max + 1;
    previous = current;
  }

  return previous[b.length];
}

/**
 * One correction for a near-miss domain, or null.
 *
 * ── The rules, and why each is there ───────────────────────────────────────
 *  - ONE suggestion, never a list. A list is a quiz; the point is a single
 *    obvious "oh, yes, that one".
 *  - Never for an exact match, obviously — and never when the typed domain is
 *    itself a known-good provider, so `me.com` is not "corrected" to `proton.me`.
 *  - Distance 1 for short domains, 2 for longer ones. A fixed threshold of 2 on
 *    a nine-character domain is a plausible typo; on a five-character one it is
 *    a different domain.
 *  - The CONFIGURED domain outranks the provider list. When the instructor said
 *    `dartmouth.edu`, that is the answer, and it should win over any coincidence
 *    with a mailbox host.
 *
 * It is a suggestion and nothing else: the caller renders it as text next to
 * the field. Nothing here rewrites what the person typed — an auto-correct that
 * is wrong silently files the response under an address they do not own.
 */
export function suggestDomain(domain: string, configured?: string | null): string | null {
  const typed = domain.trim().toLowerCase();
  if (!typed) return null;

  const candidates = [
    ...(configured ? [configured.trim().toLowerCase()] : []),
    ...COMMON_DOMAINS,
  ].filter(Boolean);

  // Typed exactly one of the things we would propose: nothing to say.
  if (candidates.includes(typed)) return null;

  let best: { domain: string; distance: number } | null = null;

  for (const candidate of candidates) {
    const ceiling = candidate.length <= 8 ? 1 : 2;
    const distance = editDistance(typed, candidate, ceiling);
    if (distance > ceiling) continue;
    // Ties go to the earlier candidate, which puts the configured domain first.
    if (!best || distance < best.distance) best = { domain: candidate, distance };
  }

  return best?.domain ?? null;
}
