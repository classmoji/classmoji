/**
 * Fly.io certificate management for class-site custom domains.
 *
 * A custom domain is two things: a row in `classroom_sites.custom_domain` (ours)
 * and a certificate on the Fly app that terminates TLS for it (theirs). This
 * module owns the second half, against the documented Machines REST API:
 *
 *   POST   /v1/apps/{app}/certificates/acme        request issuance
 *   GET    /v1/apps/{app}/certificates            list (reconciliation)
 *   GET    /v1/apps/{app}/certificates/{hostname} current state
 *   POST   /v1/apps/{app}/certificates/{hostname}/check  force a re-check
 *   DELETE /v1/apps/{app}/certificates/{hostname} remove
 *
 * Three properties this file exists to guarantee:
 *
 *  - **Boot-safe.** Nothing is read at module load. A deployment with no Fly
 *    credentials imports this happily and every call fails with a typed
 *    NOT_CONFIGURED — the feature degrades to "ask an admin for a certificate"
 *    rather than taking the process down. `@classmoji/services` is imported by
 *    five apps; only one of them will ever have these secrets.
 *  - **App-targeted, always.** Every path is built from `FLY_PAGES_APP` and the
 *    service REFUSES to run when it is unset. There is no default: staging and
 *    production share one `fly.toml`, so a missing value would otherwise mean a
 *    staging click quietly writing a certificate onto the production app.
 *  - **Idempotent.** `addCert` on an existing hostname and `removeCert` on a
 *    missing one both succeed. Both are called from paths that can be retried
 *    (a double-submitted form, a reconcile sweep), and Fly's own guidance is
 *    that recreating certificates burns issuance rate limit.
 *  - **It will not delete our own certificates.** `removeCert` refuses platform
 *    hostnames outright. The certificates on this app are not only the tenants':
 *    the wildcard that terminates TLS for every `{subdomain}.classmoji.io` class
 *    site lives here too, and no caller can ever legitimately ask for it to go —
 *    a custom domain under a platform domain is rejected by `setCustomDomain`
 *    and by a CHECK constraint, so it can never be a claim. The refusal costs
 *    nothing and the mistake it prevents is a silent TLS outage across every
 *    class site (a failed handshake has no status code, so health checks stay
 *    green).
 *
 * The normalized `FlyCertificate` below covers the fields the product actually
 * renders. `raw` carries the untouched response alongside it, deliberately: the
 * exact payload shape is Fly's to change, and a UI that needs one more field
 * should not need a service release.
 */

import { isPlatformDomain } from '@classmoji/utils';

/** Why a Fly certificate call failed, as something a caller can branch on. */
export const FLY_CERT_ERROR = {
  /** FLY_CERTS_API_TOKEN or FLY_PAGES_APP is unset — the feature is off. */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** We declined to make the call. Never Fly's opinion; always ours. */
  REFUSED: 'REFUSED',
  /** Fly rejected the credential (401/403). Almost always token scope. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** No certificate for this hostname on this app. */
  NOT_FOUND: 'NOT_FOUND',
  /** Fly's per-registered-domain issuance limit. Retrying now will not help. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Anything else Fly said, plus network failures and timeouts. */
  UPSTREAM: 'UPSTREAM',
} as const;

export type FlyCertErrorCode = (typeof FLY_CERT_ERROR)[keyof typeof FLY_CERT_ERROR];

export class FlyCertError extends Error {
  readonly code: FlyCertErrorCode;
  /** HTTP status, when the failure came from a response rather than the wire. */
  readonly status?: number;

  constructor(code: FlyCertErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'FlyCertError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The DNS records Fly says this hostname needs.
 *
 * Rendered rather than hardcoded, and that is the point: the A/AAAA addresses
 * are PER APP, so production's and staging's differ even though they share a
 * `fly.toml`. Printing a constant pair of IPs in the admin UI would send half
 * our users to the wrong anycast address.
 *
 * `aaaa` / `acme_challenge` / `ownership` are alternatives, not extras: Fly
 * validates ownership through any ONE of an AAAA record, an `_acme-challenge`
 * CNAME, or a `_fly-ownership` TXT. An A record alone proves you can point a
 * name at us, not that you own it — which is why an A-only setup sits on
 * "pending" forever and why all three have to reach the instructor.
 */
export type FlyDnsRequirements = {
  a?: string[];
  aaaa?: string[];
  cname?: string[];
  acme_challenge?: string[];
  ownership?: string[];
};

/** A certificate's state, normalized to the fields the product renders. */
export type FlyCertificate = {
  hostname: string;
  /** Fly's own summary: 'active' | 'pending_validation' | 'pending_ownership' | … */
  status: string | null;
  /** Is DNS currently pointing here? NOT the same question as "issued". */
  configured: boolean;
  /** Per-method validation results, when Fly reported them. */
  validation: Record<string, unknown> | null;
  dnsRequirements: FlyDnsRequirements;
  /** Only present on a `/check` response: what Fly actually resolved. */
  dnsRecords: Record<string, unknown> | null;
  validationErrors: unknown[];
  /** The untouched response, so a caller never has to wait on this file. */
  raw: Record<string, unknown>;
};

type FlyConfig = {
  token: string;
  app: string;
  baseUrl: string;
};

/** How long a single Fly request may take before we give up on it. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Retries for 429/5xx only. Three attempts total, ~0.5s then ~1s apart. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

/**
 * Read the Fly config, or null when the feature is not configured here.
 *
 * Read at CALL time, never cached at module load: the same reason
 * `apps/pages/app/site/env.server.ts` does it — a module-level snapshot pins a
 * stale value across a dev hot-reload, and in tests it makes the environment
 * unmockable after the first import.
 *
 * `FLY_CERTS_API_TOKEN`, deliberately NOT `FLY_API_TOKEN`: flyctl itself reads
 * that name, so putting a certificate credential there would silently
 * re-authenticate every local `flyctl` invocation in this repo as it.
 */
function readConfig(env: NodeJS.ProcessEnv = process.env): FlyConfig | null {
  const token = (env.FLY_CERTS_API_TOKEN || '').trim();
  const app = (env.FLY_PAGES_APP || '').trim();
  if (!token || !app) return null;

  const baseUrl = (env.FLY_API_HOSTNAME || 'https://api.machines.dev').trim().replace(/\/+$/, '');
  return { token, app, baseUrl };
}

/**
 * Is certificate automation available in this process?
 *
 * Callers use this to decide between "claim and provision" and "claim, then
 * show manual DNS instructions" — never to decide whether to CATCH. Every
 * method still throws NOT_CONFIGURED on its own.
 */
export function isFlyCertsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readConfig(env) !== null;
}

function requireConfig(): FlyConfig {
  const config = readConfig();
  if (!config) {
    throw new FlyCertError(
      FLY_CERT_ERROR.NOT_CONFIGURED,
      'Fly certificate automation is not configured (FLY_CERTS_API_TOKEN and FLY_PAGES_APP are both required).'
    );
  }
  return config;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Map a response status onto our error vocabulary. */
function errorForStatus(status: number, body: string): FlyCertError {
  if (status === 401 || status === 403) {
    return new FlyCertError(
      FLY_CERT_ERROR.UNAUTHORIZED,
      `Fly rejected the certificate credential (${status}). Check the token's scope covers this app. ${body}`.trim(),
      status
    );
  }
  if (status === 404) {
    return new FlyCertError(FLY_CERT_ERROR.NOT_FOUND, `Fly: not found. ${body}`.trim(), status);
  }
  if (status === 429) {
    return new FlyCertError(
      FLY_CERT_ERROR.RATE_LIMITED,
      `Fly certificate rate limit reached. ${body}`.trim(),
      status
    );
  }
  return new FlyCertError(
    FLY_CERT_ERROR.UPSTREAM,
    `Fly returned ${status}. ${body}`.trim(),
    status
  );
}

/**
 * One Fly API call, with a timeout and bounded retries.
 *
 * Retries cover 429 and 5xx and network failures — the transient shapes.
 * A 4xx is a statement about the request and is surfaced immediately; retrying
 * an unauthorized token three times just makes the admin wait three times as
 * long for the same message.
 */
async function flyFetch(
  config: FlyConfig,
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' }
): Promise<{ status: number; body: string }> {
  const url = `${config.baseUrl}/v1/apps/${encodeURIComponent(config.app)}${path}`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });

      const body = await response.text();

      if (response.ok) return { status: response.status, body };

      const shouldRetry = response.status === 429 || response.status >= 500;
      if (!shouldRetry || attempt === MAX_ATTEMPTS) throw errorForStatus(response.status, body);

      lastError = errorForStatus(response.status, body);
    } catch (error: unknown) {
      // A typed error from the branch above is the decision, not a wire fault.
      if (error instanceof FlyCertError) {
        if (error.code !== FLY_CERT_ERROR.RATE_LIMITED && error.status && error.status < 500)
          throw error;
        if (attempt === MAX_ATTEMPTS) throw error;
        lastError = error;
      } else {
        if (attempt === MAX_ATTEMPTS) {
          throw new FlyCertError(
            FLY_CERT_ERROR.UPSTREAM,
            `Could not reach the Fly API: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        lastError = error;
      }
    } finally {
      clearTimeout(timer);
    }

    await sleep(RETRY_BASE_MS * attempt);
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw lastError instanceof FlyCertError
    ? lastError
    : new FlyCertError(FLY_CERT_ERROR.UPSTREAM, 'Fly API call failed.');
}

/** Parse a JSON body, tolerating an empty one (204s, and DELETE's 200). */
function parseJson(body: string): Record<string, unknown> {
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Narrow Fly's payload to the fields we render, keeping the original beside it. */
function normalizeCertificate(hostname: string, payload: Record<string, unknown>): FlyCertificate {
  const requirements = (payload.dns_requirements ?? {}) as FlyDnsRequirements;
  return {
    hostname: typeof payload.hostname === 'string' ? payload.hostname : hostname,
    status: typeof payload.status === 'string' ? payload.status : null,
    configured: payload.configured === true,
    validation:
      payload.validation && typeof payload.validation === 'object'
        ? (payload.validation as Record<string, unknown>)
        : null,
    dnsRequirements: requirements && typeof requirements === 'object' ? requirements : {},
    dnsRecords:
      payload.dns_records && typeof payload.dns_records === 'object'
        ? (payload.dns_records as Record<string, unknown>)
        : null,
    validationErrors: Array.isArray(payload.validation_errors) ? payload.validation_errors : [],
    raw: payload,
  };
}

/**
 * Ask Fly to issue a certificate for a hostname.
 *
 * Idempotent by design. Fly does not document its response to a duplicate
 * request, and the possibilities (201 with the existing record, 409, 422) all
 * mean the same thing to us — the certificate we wanted exists — so a conflict
 * is resolved by reading the current state rather than by failing the claim.
 * This matters more than it looks: `setCustomDomain` writes the row first, so a
 * hard failure here would leave a claimed domain the admin cannot re-provision
 * without first un-claiming it.
 *
 * Validation itself needs nothing from this app. Fly answers ACME challenges at
 * its proxy (TLS-ALPN, or DNS-01), so no `/.well-known/acme-challenge/` traffic
 * ever reaches us — for issuance OR for the 90-day renewal. That is why the
 * class-site request path can keep refusing `.well-known` on tenant hosts.
 */
export async function addCert(hostname: string): Promise<FlyCertificate> {
  const config = requireConfig();

  try {
    const { body } = await flyFetch(config, '/certificates/acme', {
      method: 'POST',
      body: { hostname },
    });
    return normalizeCertificate(hostname, parseJson(body));
  } catch (error: unknown) {
    const conflict =
      error instanceof FlyCertError &&
      error.status !== undefined &&
      (error.status === 409 || error.status === 422);
    if (!conflict) throw error;
    return getCertStatus(hostname);
  }
}

/**
 * The current state of a hostname's certificate.
 *
 * `{ check: true }` issues Fly's `/check`, which re-resolves DNS and returns
 * what it actually found alongside what it requires — the difference between
 * "we asked for this record" and "this record is live". Costs a real DNS
 * lookup on Fly's side, so it belongs behind an explicit admin action (the
 * status chip's refresh), not on a page load.
 */
export async function getCertStatus(
  hostname: string,
  options: { check?: boolean } = {}
): Promise<FlyCertificate> {
  const config = requireConfig();
  const encoded = encodeURIComponent(hostname);

  const { body } = options.check
    ? await flyFetch(config, `/certificates/${encoded}/check`, { method: 'POST' })
    : await flyFetch(config, `/certificates/${encoded}`, { method: 'GET' });

  return normalizeCertificate(hostname, parseJson(body));
}

/**
 * Remove a hostname's certificate.
 *
 * Returns `false` when there was nothing to remove, rather than throwing: every
 * caller (clearCustomDomain, deleteSiteForClassroom, the reconcile sweep) is
 * expressing "this hostname must not have a certificate", and a hostname that
 * already has none satisfies that. Throwing here would mean a site delete could
 * fail on cleanup it did not need to do.
 *
 * REFUSES platform hostnames, before it even reads the config. This app also
 * holds the wildcard that terminates TLS for every `{subdomain}.classmoji.io`
 * class site and the canonical `pages.` host; deleting either is a silent
 * outage that no health check can see. No legitimate caller can reach this —
 * a platform hostname can never be a claim — so the guard costs one comparison
 * and closes the whole class of "our own certificate ended up in a delete list".
 */
export async function removeCert(hostname: string): Promise<boolean> {
  // Normalized for the comparison only; Fly is given the hostname as passed.
  const normalized = String(hostname ?? '')
    .trim()
    .toLowerCase();
  if (isPlatformDomain(normalized)) {
    throw new FlyCertError(
      FLY_CERT_ERROR.REFUSED,
      `Refusing to delete the certificate for ${hostname}: that is a Classmoji platform hostname.`
    );
  }

  const config = requireConfig();

  try {
    await flyFetch(config, `/certificates/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
    return true;
  } catch (error: unknown) {
    if (error instanceof FlyCertError && error.code === FLY_CERT_ERROR.NOT_FOUND) return false;
    throw error;
  }
}

/**
 * Every hostname with a certificate on the app.
 *
 * Exists for the reconcile task. Deleting a classroom cascades its
 * ClassroomSite row away inside the database, with no application code on the
 * path — so no `removeCert` can run, and the hostname stops being enumerable
 * from our side entirely. A periodic diff against this list is the only thing
 * that can find those orphans.
 */
export async function listCerts(): Promise<string[]> {
  const config = requireConfig();
  const { body } = await flyFetch(config, '/certificates', { method: 'GET' });

  const payload = JSON.parse(body || '[]');
  // Fly returns a bare array today; tolerate a wrapped `{ certificates: [...] }`
  // rather than reconciling zero hostnames (and deleting nothing) if it changes.
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { certificates?: unknown }).certificates)
      ? (payload as { certificates: unknown[] }).certificates
      : [];

  return rows
    .map(row =>
      row && typeof row === 'object' ? (row as { hostname?: unknown }).hostname : undefined
    )
    .filter((hostname): hostname is string => typeof hostname === 'string' && hostname.length > 0);
}

const FlyCertService = {
  isConfigured: isFlyCertsConfigured,
  addCert,
  getCertStatus,
  removeCert,
  listCerts,
};

export default FlyCertService;
