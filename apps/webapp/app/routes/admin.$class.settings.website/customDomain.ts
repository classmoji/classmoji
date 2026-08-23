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
}

/**
 * Which part of the setup a requirement belongs to.
 *
 * `direct` and `alias` are two ways to do the SAME job — carry traffic — and
 * the instructor picks one. `proof` is the separate ownership question, where
 * any single record is enough. Fly returns all of them in one flat
 * `dns_requirements` object with nothing marking the difference, which is how
 * a table headed "add these, copy them exactly" came to present a set of
 * alternatives as a checklist.
 */
type RequirementGroup = 'direct' | 'alias' | 'proof';

/** How each `dns_requirements` key is presented. Order is the order shown. */
const REQUIREMENT_SHAPES: ReadonlyArray<{
  key: string;
  type: string;
  prefix?: string;
  group: RequirementGroup;
}> = [
  { key: 'a', type: 'A', group: 'direct' },
  { key: 'aaaa', type: 'AAAA', group: 'direct' },
  { key: 'cname', type: 'CNAME', group: 'alias' },
  { key: 'acme_challenge', type: 'CNAME', prefix: '_acme-challenge', group: 'proof' },
  { key: 'ownership', type: 'TXT', prefix: '_fly-ownership', group: 'proof' },
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

/** Fly's requirements, sorted into the three groups, values already rendered. */
function groupRequirements(
  requirements: Record<string, unknown> | null | undefined,
  domain: string
): Record<RequirementGroup, DnsRow[]> {
  const groups: Record<RequirementGroup, DnsRow[]> = { direct: [], alias: [], proof: [] };
  if (!requirements || typeof requirements !== 'object') return groups;

  const seen = new Set<string>();

  const push = (
    shape: { type: string; prefix?: string; group: RequirementGroup },
    raw: unknown
  ) => {
    const value = displayValue(raw);
    if (!value) return;
    const name = shape.prefix ? `${shape.prefix}.${domain}` : domain;
    const dedupe = `${shape.type}|${name}|${value}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    groups[shape.group].push({ type: shape.type, name, value });
  };

  const consume = (
    key: string,
    shape: { type: string; prefix?: string; group: RequirementGroup }
  ) => {
    const entry = (requirements as Record<string, unknown>)[key];
    if (entry === undefined || entry === null) return;
    if (Array.isArray(entry)) entry.forEach(item => push(shape, item));
    else push(shape, entry);
  };

  for (const shape of REQUIREMENT_SHAPES) consume(shape.key, shape);

  // Unknown keys land in `proof`, the section whose instruction ("any one of
  // these") stays true for a record we have never seen. Putting them among the
  // routing alternatives would claim they are interchangeable with a CNAME.
  const known = new Set(REQUIREMENT_SHAPES.map(shape => shape.key));
  for (const key of Object.keys(requirements)) {
    if (known.has(key)) continue;
    consume(key, { type: key.toUpperCase(), group: 'proof' });
  }

  return groups;
}

/** One way to route the hostname here. The instructor picks exactly one. */
export interface DnsRouteOption {
  id: 'direct' | 'alias';
  /** The record types this option is made of, as a heading. */
  label: string;
  /** When to pick this one. */
  summary: string;
  rows: DnsRow[];
  /** Set only when these records ALSO settle the ownership question. */
  note: string | null;
}

export interface DnsPlan {
  /** Empty when Fly asked for no routing records at all. */
  heading: string;
  /** ALTERNATIVES. One is enough; adding both is not required. */
  routing: DnsRouteOption[];
  /** Any ONE of these proves ownership. */
  proof: DnsRow[];
}

/**
 * Fly's `dns_requirements`, arranged the way they actually work.
 *
 * Fly returns `a`, `aaaa`, `cname`, `acme_challenge` and `ownership` side by
 * side in one object, and a flat table of all of them reads as a checklist.
 * It is not one: A(+AAAA) and CNAME are two ROUTES to the same place, and an
 * instructor who dutifully adds both has published a CNAME alongside an A on
 * the same name — a configuration many DNS hosts refuse outright and the rest
 * resolve unpredictably.
 *
 * The values themselves are rendered, never hardcoded: the addresses behind a
 * Fly app are per APP, so staging and production differ despite sharing a
 * `fly.toml`, and a constant pair printed here would go stale the day Fly
 * renumbers.
 *
 * AAAA is deliberately shown with A rather than among the proof records, even
 * though Fly accepts it as ownership proof. It is a routing record first — it
 * is how IPv6 clients reach the site — and its double duty is stated in the
 * option's note instead, where it reads as "you can skip the next section"
 * rather than as a sixth thing to add.
 */
export function dnsPlan(
  requirements: Record<string, unknown> | null | undefined,
  domain: string
): DnsPlan {
  const groups = groupRequirements(requirements, domain);
  const routing: DnsRouteOption[] = [];

  if (groups.direct.length > 0) {
    const provesOwnership = groups.direct.some(row => row.type === 'AAAA');
    // Deduplicated: Fly can return two A addresses, and "A + A records" is not
    // a description of anything.
    const types = [...new Set(groups.direct.map(row => row.type))];
    routing.push({
      id: 'direct',
      label: `${types.join(' + ')} ${types.length > 1 ? 'records' : 'record'}`,
      summary:
        'Point the name straight at our addresses. Works anywhere, including at a root domain like cs52.me where a CNAME often cannot go.',
      rows: groups.direct,
      note: provesOwnership
        ? 'The AAAA does double duty: it routes IPv6 traffic AND proves you own the domain, so adding it lets you skip the records below.'
        : null,
    });
  }

  if (groups.alias.length > 0) {
    routing.push({
      id: 'alias',
      label: 'CNAME record',
      summary:
        'One record, and it follows us if our addresses ever change. Many DNS hosts refuse a CNAME at a root domain — there, use their ALIAS, ANAME or CNAME flattening record (Cloudflare flattens automatically), or take the addresses instead.',
      rows: groups.alias,
      note: null,
    });
  }

  return {
    heading:
      routing.length > 1
        ? `Point ${domain} at Classmoji — choose ONE of these:`
        : `Point ${domain} at Classmoji`,
    routing,
    proof: groups.proof,
  };
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
    rows: [{ type: 'CNAME', name: domain, value: target }],
    notes: [
      'If this is a root domain (no www in front), some DNS hosts will not accept a CNAME there — use their ALIAS, ANAME or CNAME flattening record with the same value instead. Cloudflare does this for you automatically.',
      'On Cloudflare, set the record to DNS only (the grey cloud). Leaving it proxied on the orange cloud stops the certificate from being issued.',
    ],
    footer: 'Your certificate will be issued automatically once your domain points at Classmoji.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What Fly says is wrong with the records
// ─────────────────────────────────────────────────────────────────────────────

/** One of Fly's `validation_errors`, as a sentence rather than a payload. */
export interface CertProblem {
  /** Fly's machine code, for the muted tag. Null when it did not give one. */
  code: string | null;
  /** The human sentence. Never empty — falls back to the raw text. */
  message: string;
  /** What to do about it, when Fly said. */
  remediation: string | null;
}

/** A trimmed string field, or null for anything else. */
function textField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Fly's validation errors, made readable.
 *
 * These were rendered with `JSON.stringify`, so an instructor whose CNAME
 * pointed at the wrong host was shown
 * `{"code":"DNS_RECORD_MISMATCH","message":…,"remediation":…}` — a payload
 * carrying, in `remediation`, the exact fix, which nobody reads out of a brace
 * soup. The message and the remediation are the whole value here; the code is
 * kept because it is what a support conversation can be searched on.
 *
 * Three shapes are tolerated because we do not control any of them: an object,
 * a STRING holding that object's JSON (which is how the blob reached the screen
 * in the first place), and a plain sentence. Anything unrecognized is printed
 * as-is rather than dropped — a certificate that will not issue and an empty
 * error list is the worst screen this row can show.
 */
export function certProblems(errors: unknown[] | null | undefined): CertProblem[] {
  if (!Array.isArray(errors)) return [];

  const problems: CertProblem[] = [];

  for (const entry of errors) {
    let source: Record<string, unknown> | null = null;
    let fallback = '';

    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      source = entry as Record<string, unknown>;
    } else if (typeof entry === 'string') {
      fallback = entry.trim();
      if (!fallback) continue;
      // Fly hands some of these over as a JSON string; a brace here is worth
      // one parse attempt before giving up and printing the sentence.
      if (fallback.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(fallback);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            source = parsed as Record<string, unknown>;
          }
        } catch {
          // Not JSON after all. `fallback` already holds what to show.
        }
      }
    } else if (entry !== null && entry !== undefined) {
      fallback = String(entry);
    }

    if (!source) {
      if (fallback) problems.push({ code: null, message: fallback, remediation: null });
      continue;
    }

    const message =
      textField(source, 'message') ??
      textField(source, 'detail') ??
      textField(source, 'error') ??
      // Never nothing: an object with no field we know still beats a silently
      // shorter list.
      (() => {
        try {
          return JSON.stringify(source);
        } catch {
          return fallback || 'Fly reported a problem with this domain.';
        }
      })();

    problems.push({
      code: textField(source, 'code'),
      message,
      remediation: textField(source, 'remediation'),
    });
  }

  return problems;
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
