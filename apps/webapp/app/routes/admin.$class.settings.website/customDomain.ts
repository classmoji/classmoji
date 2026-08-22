/**
 * The Custom domain row's decisions, as pure functions.
 *
 * Same split as siteSettings.ts, for the same reason: the route is a form, and
 * the judgements worth testing without a browser are the ones below — which
 * variant of the row to draw, what the certificate is currently doing, what to
 * say about a rejected domain, and whether the box holds something worth
 * submitting.
 *
 * Shapes here are structural rather than imported from `@classmoji/services`:
 * this module is in the CLIENT bundle, and a structural type keeps it that way
 * while still describing exactly what the loader hands down.
 */

import { normalizeCustomDomain, isValidCustomDomain, isPlatformDomain } from '@classmoji/utils';

/** The custom-domain fields the row reads off the loader's site row. */
export interface CustomDomainSiteFields {
  custom_domain: string | null;
  custom_domain_verified_at: Date | string | null;
}

/**
 * Which variant of the row to draw.
 *
 * `lapsed` is separate from `locked` and that separation is the point: an owner
 * whose subscription ended still HAS a claimed domain, still has a DNS record
 * pointing at us, and must be able to take both down. Collapsing it into
 * `locked` would hide the Remove button behind the paywall and strand them —
 * which is also why `clearCustomDomain` is the one custom-domain service call
 * with no Pro gate.
 */
export type CustomDomainRowState =
  /** No site row yet — nothing to attach a domain to. */
  | 'no-site'
  /** Not Pro, no domain claimed: the upgrade pitch. */
  | 'locked'
  /** Not Pro, but a domain is still claimed: explain and offer removal. */
  | 'lapsed'
  /** Pro, no domain yet: the input. */
  | 'claim'
  /** Pro, domain claimed, never served over its own hostname. */
  | 'pending'
  /** Pro, domain claimed, and it has served over its own hostname. */
  | 'verified';

export function customDomainRowState(input: {
  isPro: boolean;
  site: CustomDomainSiteFields | null;
}): CustomDomainRowState {
  const { isPro, site } = input;
  if (!site) return 'no-site';

  const domain = site.custom_domain;
  if (!isPro) return domain ? 'lapsed' : 'locked';
  if (!domain) return 'claim';
  return site.custom_domain_verified_at ? 'verified' : 'pending';
}

// ─────────────────────────────────────────────────────────────────────────────
// What the instructor types
// ─────────────────────────────────────────────────────────────────────────────

/** A client-side read of the domain box. Advisory — the service decides. */
export type DomainInputVerdict =
  | { state: 'empty'; normalized: '' }
  | { state: 'invalid'; normalized: string; message: string }
  | { state: 'reserved'; normalized: string; message: string }
  | { state: 'ok'; normalized: string };

/**
 * Judge what is in the box, in the SAME order `setCustomDomain` does.
 *
 * Shape before platform-domain, because they are two different mistakes and
 * `classmoji.io/` (a typo with a slash) should read as malformed rather than as
 * "that one is ours". Normalization is delegated to `normalizeCustomDomain`
 * rather than re-implemented, so the value this previews is byte-identical to
 * the value the service will store — a local `toLowerCase()` that forgot the
 * trailing dot would show a verdict for a string nobody ever saves.
 *
 * Never a claim of availability: DOMAIN_TAKEN is a database question and comes
 * back from the save.
 */
export function checkDomainInput(raw: string | null | undefined): DomainInputVerdict {
  const normalized = normalizeCustomDomain(raw);
  if (!normalized) return { state: 'empty', normalized: '' };

  if (!isValidCustomDomain(normalized)) {
    return {
      state: 'invalid',
      normalized,
      message: "Enter a bare hostname like 'cs52.me' — no https://, no path, no port.",
    };
  }
  if (isPlatformDomain(normalized)) {
    return {
      state: 'reserved',
      normalized,
      message: 'That domain belongs to Classmoji. Connect a domain you own.',
    };
  }
  return { state: 'ok', normalized };
}

/** May Save be pressed? Advisory only — every rule is enforced again server-side. */
export function canSubmitDomain(verdict: DomainInputVerdict, isSubmitting: boolean): boolean {
  return verdict.state === 'ok' && !isSubmitting;
}

// ─────────────────────────────────────────────────────────────────────────────
// What the certificate is doing
// ─────────────────────────────────────────────────────────────────────────────

/** The certificate fields the row renders, as the loader narrows them. */
export interface CertSnapshot {
  status: string | null;
  configured: boolean;
  dnsRequirements: Record<string, unknown> | null;
  validationErrors: unknown[];
}

export type CertChipTone = 'active' | 'issuing' | 'pending' | 'unknown' | 'manual';

export interface CertChip {
  tone: CertChipTone;
  label: string;
  hint: string;
}

/**
 * The status chip, from Fly's own words.
 *
 * Three real states and two absences:
 *
 *  - **Pending DNS** — `configured: false`. Fly cannot see the records yet, so
 *    nothing is going to happen until the instructor edits their zone. This is
 *    where a claim sits for as long as it takes, and the DNS table below the
 *    chip is the actual instruction.
 *  - **Issuing** — records are visible and Fly is working. Nothing to do but
 *    wait, which is why the refresh is a button and not a poll.
 *  - **Active** — a certificate exists and the hostname terminates TLS.
 *
 * `status` is matched case-insensitively and anything unrecognized falls through
 * to Issuing rather than to an error: Fly's vocabulary
 * (`pending_validation`, `pending_ownership`, …) is theirs to extend, and a new
 * word must not turn a healthy certificate into a scary chip.
 *
 * NOTE that none of this is what makes a domain VERIFIED. An active certificate
 * says TLS will complete; `custom_domain_verified_at` says a request actually
 * arrived over the hostname, which is what the canonical flip gates on.
 */
export function certChip(
  cert: CertSnapshot | null | undefined,
  options: { flyConfigured: boolean }
): CertChip {
  if (!options.flyConfigured) {
    return {
      tone: 'manual',
      label: 'Manual setup',
      // Deliberately empty. `manualDomainSetup` below is the single instruction
      // in this mode, and a hint here printed the same sentence a second time
      // directly above it — twice as much text, no extra information, and none
      // of it anything the instructor could act on.
      hint: '',
    };
  }
  if (!cert) {
    return {
      tone: 'unknown',
      label: 'No certificate yet',
      hint: 'We have not been able to read a certificate for this domain. Check status to request one.',
    };
  }

  const status = (cert.status ?? '').trim().toLowerCase();
  if (status === 'active' || status === 'ready') {
    return {
      tone: 'active',
      label: 'Active',
      hint: 'The certificate is issued — your domain serves over HTTPS.',
    };
  }
  if (!cert.configured) {
    return {
      tone: 'pending',
      label: 'Pending DNS',
      hint: 'Add the records below at your DNS provider. Issuance starts on its own once they resolve.',
    };
  }
  return {
    tone: 'issuing',
    label: 'Issuing',
    hint: 'Your records are visible and the certificate is being issued. This usually takes a few minutes.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What to put in the zone file
// ─────────────────────────────────────────────────────────────────────────────

export interface DnsRow {
  /** The record type to create. */
  type: string;
  /** The name/host to create it under. */
  name: string;
  /** What Fly said to point it at. */
  value: string;
  /**
   * `route` records carry traffic; `proof` records prove ownership and ANY ONE
   * of them is enough. An A record alone routes but proves nothing, which is
   * the single most common reason a claim sits on Pending DNS forever.
   */
  purpose: 'route' | 'proof';
}

/** How each `dns_requirements` key is presented. Order is the order shown. */
const REQUIREMENT_SHAPES: ReadonlyArray<{
  key: string;
  type: string;
  prefix?: string;
  purpose: 'route' | 'proof';
}> = [
  { key: 'a', type: 'A', purpose: 'route' },
  { key: 'cname', type: 'CNAME', purpose: 'route' },
  { key: 'aaaa', type: 'AAAA', purpose: 'proof' },
  { key: 'acme_challenge', type: 'CNAME', prefix: '_acme-challenge', purpose: 'proof' },
  { key: 'ownership', type: 'TXT', prefix: '_fly-ownership', purpose: 'proof' },
];

/** Render whatever Fly put in a requirement slot, without guessing at its shape. */
function displayValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const field of ['value', 'hostname', 'target', 'record']) {
      if (typeof record[field] === 'string' && record[field]) return record[field] as string;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The DNS records to publish, straight from Fly's `dns_requirements`.
 *
 * Rendered, never hardcoded. The A/AAAA addresses are per Fly APP, so staging
 * and production differ despite sharing a `fly.toml` — printing a constant pair
 * of addresses in this tab would send half our instructors to the wrong anycast
 * address, and would go stale silently the day Fly renumbers.
 *
 * Unknown keys are carried through as-is rather than dropped: if Fly starts
 * requiring a record type we have never seen, an instructor who can read it off
 * the screen is unblocked, whereas one who cannot has a domain that never
 * issues and no way to find out why.
 */
export function dnsRows(
  requirements: Record<string, unknown> | null | undefined,
  domain: string
): DnsRow[] {
  if (!requirements || typeof requirements !== 'object') return [];

  const rows: DnsRow[] = [];
  const seen = new Set<string>();

  const push = (
    shape: { type: string; prefix?: string; purpose: 'route' | 'proof' },
    raw: unknown
  ) => {
    const value = displayValue(raw);
    if (!value) return;
    const name = shape.prefix ? `${shape.prefix}.${domain}` : domain;
    const dedupe = `${shape.type}|${name}|${value}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    rows.push({ type: shape.type, name, value, purpose: shape.purpose });
  };

  const consume = (
    key: string,
    shape: { type: string; prefix?: string; purpose: 'route' | 'proof' }
  ) => {
    const entry = (requirements as Record<string, unknown>)[key];
    if (entry === undefined || entry === null) return;
    if (Array.isArray(entry)) entry.forEach(item => push(shape, item));
    else push(shape, entry);
  };

  for (const shape of REQUIREMENT_SHAPES) consume(shape.key, shape);

  const known = new Set(REQUIREMENT_SHAPES.map(shape => shape.key));
  for (const key of Object.keys(requirements)) {
    if (known.has(key)) continue;
    consume(key, { type: key.toUpperCase(), purpose: 'proof' });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// What to put in the zone file when nothing is automated
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The hostname a manual setup points at — the pages app's own Fly address.
 *
 * `FLY_PAGES_APP` is an app NAME (`classmoji-pages`), and every Fly app answers
 * on `{app}.fly.dev`, so this is the one piece of routing we can state without
 * asking Fly anything. Null when the name is unset, which is the only reason
 * the fallback below exists.
 */
export function manualCnameTarget(pagesApp: string | null | undefined): string | null {
  const app = (pagesApp ?? '').trim().toLowerCase();
  return app ? `${app}.fly.dev` : null;
}

/**
 * What the Custom domain row shows when certificate automation is off.
 *
 * `dns` when we know where to send them, `unavailable` when we do not.
 */
export type ManualDomainSetup =
  | { state: 'unavailable'; message: string }
  | { state: 'dns'; heading: string; rows: DnsRow[]; notes: string[]; footer: string };

/**
 * The instructor's next step with no Fly credential in this process.
 *
 * Who issues the certificate is OUR problem, and this instructions block says
 * nothing about it: the DNS record is the same record either way, it is the
 * only part of the setup the instructor can do, and it is the part that must
 * happen first. The previous copy — "an administrator has to issue the
 * certificate", printed twice — was a description of our internal state
 * dressed up as an instruction, and left a paying customer with nothing to do.
 *
 * A CNAME, never an A record: the addresses behind a Fly app are per app and
 * change, and there is no credential here to go and read them. The apex caveat
 * rides along as a note rather than as detection — a label count calls
 * `cs52.co.uk` a subdomain, and we have no public-suffix list in this bundle.
 */
export function manualDomainSetup(input: {
  domain: string | null | undefined;
  pagesApp: string | null | undefined;
}): ManualDomainSetup {
  const domain = (input.domain ?? '').trim().toLowerCase();
  const target = manualCnameTarget(input.pagesApp);

  // Nothing true left to say. One honest line beats inventing a hostname or
  // repeating jargon at someone who cannot act on either.
  if (!domain || !target) {
    return {
      state: 'unavailable',
      message:
        'Your Classmoji administrator needs to finish configuring custom domains — contact support.',
    };
  }

  return {
    state: 'dns',
    heading: `Point ${domain} at Classmoji`,
    rows: [{ type: 'CNAME', name: domain, value: target, purpose: 'route' }],
    notes: [
      'If this is a root domain (no www in front), some DNS hosts will not accept a CNAME there — use their ALIAS, ANAME or CNAME flattening record with the same value instead. Cloudflare does this for you automatically.',
      'On Cloudflare, set the record to DNS only (the grey cloud). Leaving it proxied on the orange cloud stops the certificate from being issued.',
    ],
    footer: 'Your certificate will be issued automatically once your domain points at Classmoji.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What went wrong
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The next step for a rejected save, or null when the service's own message is
 * already the whole story.
 *
 * The message from `SiteError` says what is wrong; this says what to do about
 * it. Keyed on the CODE rather than parsed out of the text, so a reworded
 * service message never silently drops the advice attached to it.
 */
export function customDomainErrorHint(code: string | null | undefined): string | null {
  switch (code) {
    case 'PRO_REQUIRED':
      return 'Custom domains are part of Pro — upgrade from Settings › Billing to connect one.';
    case 'SITE_NOT_FOUND':
      return 'Claim a Classmoji subdomain above first — the custom domain points at the same site.';
    case 'DOMAIN_INVALID':
      return "Use the bare hostname, like 'cs52.me'.";
    case 'DOMAIN_RESERVED':
      return 'Your site already answers at its Classmoji address. Connect a domain you own.';
    case 'DOMAIN_TAKEN':
      return 'Another Classmoji site already claims this domain. Remove it there first.';
    default:
      return null;
  }
}

/**
 * What to say when the claim succeeded but the certificate request did not.
 *
 * The domain IS claimed at this point — the row is written and the service
 * returned — so this is never phrased as a failure of the save. It is a
 * retryable second step, and every code below resolves to the same action:
 * press Check status, which re-requests issuance.
 *
 * NOT_CONFIGURED is the exception and returns nothing: it can only arrive in a
 * process where `flyConfigured` is false, which is exactly when the row already
 * renders `manualDomainSetup` — an actionable block that owns that message.
 * Saying it here too is how the row came to print the same sentence twice.
 */
export function certErrorNotice(code: string | null | undefined): string | null {
  switch (code) {
    case 'NOT_CONFIGURED':
      return null;
    case 'UNAUTHORIZED':
      return 'Domain claimed, but the certificate request was rejected. An administrator needs to check the Fly credential; press Check status to retry.';
    case 'RATE_LIMITED':
      return 'Domain claimed, but the certificate provider is rate-limiting new certificates for this domain. Wait a few minutes, then press Check status.';
    case 'NOT_FOUND':
    case 'UPSTREAM':
      return 'Domain claimed, but we could not reach the certificate provider. Your DNS records can go in now — press Check status to retry issuance.';
    default:
      return code
        ? 'Domain claimed, but the certificate could not be requested. Press Check status to retry.'
        : null;
  }
}
