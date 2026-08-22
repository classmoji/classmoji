/**
 * Unit tests for the custom-domain certificate reconciliation job.
 *
 * This job DELETES certificates on the live Fly app, so what matters is the
 * shape of its decisions rather than the plumbing:
 *
 *  - it deletes only what nobody claims (the classroom-delete cascade drops the
 *    site row inside Postgres with no application code on the path, so a sweep
 *    is the only thing that can ever find those orphans);
 *  - it never touches the PLATFORM's own certificates, which live on the same
 *    app and can never appear in the claim list — the wildcard that terminates
 *    TLS for every class site is on this app, and deleting it is an outage no
 *    health check can see;
 *  - it never ISSUES, because issuance is rate-limited per registered domain
 *    and a sweep that re-requested certificates would burn that budget every
 *    run on a domain whose DNS was never configured;
 *  - it deletes NOTHING rather than mass-deleting, because a claim list far
 *    shorter than the certificate list is far more likely to mean a bad read
 *    than a genuine mass release.
 *
 * `@trigger.dev/sdk` and `@classmoji/services` are mocked, so `run` is invoked
 * directly and nothing reaches Fly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listCustomDomainRoutes = vi.fn();
const listCerts = vi.fn();
const removeCert = vi.fn();
const isFlyCertsConfigured = vi.fn();

// `schedules.task()` normally returns a trigger handle; return the config so
// the test can call `run` directly.
vi.mock('@trigger.dev/sdk', () => ({
  schedules: { task: (config: unknown) => config },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// `isPlatformDomain` is re-exported by @classmoji/services (tasks has no direct
// dependency on @classmoji/utils). Mirrored here rather than stubbed to `false`
// so the platform fixtures below test the real rule, not a test double of it.
const PLATFORM_DOMAINS = ['classmoji.io', 'lvh.me', 'fly.dev'];

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    site: { listCustomDomainRoutes: (...a: unknown[]) => listCustomDomainRoutes(...a) },
  },
  FlyCertService: {
    listCerts: (...a: unknown[]) => listCerts(...a),
    removeCert: (...a: unknown[]) => removeCert(...a),
  },
  isFlyCertsConfigured: () => isFlyCertsConfigured(),
  isPlatformDomain: (domain: string) =>
    PLATFORM_DOMAINS.some(base => domain === base || domain.endsWith(`.${base}`)),
}));

const { reconcileCustomDomainCerts } = await import('../customDomains.ts');

/** What the job reports back, for the assertions below. */
type ReconcileResult = {
  skipped: boolean;
  suspicious?: boolean;
  orphaned?: number;
  removed?: string[];
  failed?: string[];
  missing?: string[];
};

const run = (): Promise<ReconcileResult> =>
  (
    reconcileCustomDomainCerts as unknown as {
      run: (p?: unknown, c?: unknown) => Promise<ReconcileResult>;
    }
  ).run({}, {});

const route = (domain: string, active = true) => ({ domain, subdomain: 'cs52', active });

beforeEach(() => {
  vi.clearAllMocks();
  isFlyCertsConfigured.mockReturnValue(true);
  removeCert.mockResolvedValue(true);
});

describe('reconcileCustomDomainCerts', () => {
  it('does nothing when certificate automation is not configured', async () => {
    isFlyCertsConfigured.mockReturnValue(false);

    await expect(run()).resolves.toMatchObject({ skipped: true });
    expect(listCerts).not.toHaveBeenCalled();
    expect(removeCert).not.toHaveBeenCalled();
  });

  it('removes a certificate for a hostname nobody claims', async () => {
    // The classroom-delete cascade: the site row is gone, so this hostname is
    // no longer enumerable from our side at all.
    listCustomDomainRoutes.mockResolvedValue([route('cs52.me')]);
    listCerts.mockResolvedValue(['cs52.me', 'deleted-class.example']);

    const result = await run();

    expect(removeCert).toHaveBeenCalledTimes(1);
    expect(removeCert).toHaveBeenCalledWith('deleted-class.example');
    expect(result.removed).toEqual(['deleted-class.example']);
  });

  it('keeps the certificate of a claim that is merely INACTIVE', async () => {
    // A lapsed subscription or a switched-off site is still a claim. Deleting
    // its certificate would make re-subscribing require a fresh issuance —
    // against the same rate limit — for a domain that never changed hands.
    listCustomDomainRoutes.mockResolvedValue([route('cs52.me', false)]);
    listCerts.mockResolvedValue(['cs52.me']);

    const result = await run();

    expect(removeCert).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
  });

  it('REPORTS a claim with no certificate and never issues one', async () => {
    // Issuance is an admin action with a rate limit attached; a sweep that
    // re-requested it would burn that budget on every run, forever.
    listCustomDomainRoutes.mockResolvedValue([route('cs52.me'), route('pending.example')]);
    listCerts.mockResolvedValue(['cs52.me']);

    const result = await run();

    expect(result.missing).toEqual(['pending.example']);
    expect(result.removed).toEqual([]);
  });

  it('compares hostnames case-insensitively', async () => {
    listCustomDomainRoutes.mockResolvedValue([route('cs52.me')]);
    listCerts.mockResolvedValue(['CS52.ME']);

    const result = await run();

    expect(removeCert).not.toHaveBeenCalled();
    expect(result.missing).toEqual([]);
  });

  it('deletes NOTHING when a run wants to delete more than the cap', async () => {
    // If this wants to delete dozens at once, the likeliest explanation is that
    // the claim list came back short for a bad reason. Stopping is recoverable;
    // deleting live certificates is not — so the cap is a blast-radius guard,
    // never a batch size. Slicing would delete the first 25 of exactly the list
    // we just decided not to trust.
    listCustomDomainRoutes.mockResolvedValue([route('cs52.me')]);
    listCerts.mockResolvedValue([
      'cs52.me',
      ...Array.from({ length: 40 }, (_, i) => `orphan-${i}.example`),
    ]);

    const result = await run();

    expect(removeCert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ suspicious: true, orphaned: 40 });
    expect(result.removed).toEqual([]);
  });

  it('deletes NOTHING when the claim list is empty but certificates exist', async () => {
    // An empty-but-successful read is the case the cap can never catch: with a
    // population of tens of rows, every live certificate fits under it. A
    // database ERROR is already safe (the read rejects before any delete), so
    // this is the only bad read that gets this far.
    listCustomDomainRoutes.mockResolvedValue([]);
    listCerts.mockResolvedValue(['cs52.me', 'paid-customer.example']);

    const result = await run();

    expect(removeCert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ suspicious: true, claimed: 0, orphaned: 2 });
  });

  it('is not suspicious when nobody has claimed a domain and only platform certs exist', async () => {
    // The genuine pre-launch state. Flagging it would fire a nightly error in
    // every environment and bury the signal the guard exists to raise.
    listCustomDomainRoutes.mockResolvedValue([]);
    listCerts.mockResolvedValue(['*.classmoji.io', 'pages.classmoji.io']);

    const result = await run();

    expect(removeCert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ suspicious: false, claimed: 0, orphaned: 0 });
  });

  it('NEVER deletes the platform wildcard or our own hostnames', async () => {
    // The wildcard on this app is what terminates TLS for every
    // {subdomain}.classmoji.io class site, and it can never appear in the claim
    // list — `setCustomDomain` and a CHECK constraint both refuse a custom
    // domain under a platform domain. A bare certs-minus-claims diff therefore
    // points straight at our own infrastructure. A failed TLS handshake carries
    // no HTTP status, so the resulting outage keeps every health check green.
    listCustomDomainRoutes.mockResolvedValue([route('cs52.me')]);
    listCerts.mockResolvedValue([
      'cs52.me',
      '*.classmoji.io',
      'pages.classmoji.io',
      '*.staging.classmoji.io',
      'classmoji-pages.fly.dev',
      'cs52.lvh.me',
      'orphan.example',
    ]);

    const result = await run();

    expect(removeCert).toHaveBeenCalledTimes(1);
    expect(removeCert).toHaveBeenCalledWith('orphan.example');
    expect(result.removed).toEqual(['orphan.example']);
  });

  it('carries on past a hostname Fly refuses to delete', async () => {
    // One stubborn hostname must not abandon the sweep — it will still be
    // orphaned tomorrow, and tomorrow this runs again. Claims are non-empty
    // here on purpose: manufacturing orphans with an empty claim list is now
    // the suspicious-read case, and it deletes nothing.
    listCustomDomainRoutes.mockResolvedValue([route('cs52.me'), route('keep.example')]);
    listCerts.mockResolvedValue(['cs52.me', 'keep.example', 'a.example', 'b.example']);
    removeCert.mockRejectedValueOnce(new Error('fly down')).mockResolvedValueOnce(true);

    const result = await run();

    expect(result.failed).toEqual(['a.example']);
    expect(result.removed).toEqual(['b.example']);
  });
});
