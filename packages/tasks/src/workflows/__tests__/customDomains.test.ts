/**
 * Unit tests for the custom-domain certificate reconciliation job.
 *
 * This job DELETES certificates on the live Fly app, so what matters is the
 * shape of its decisions rather than the plumbing:
 *
 *  - it deletes only what nobody claims (the classroom-delete cascade drops the
 *    site row inside Postgres with no application code on the path, so a sweep
 *    is the only thing that can ever find those orphans);
 *  - it never ISSUES, because issuance is rate-limited per registered domain
 *    and a sweep that re-requested certificates would burn that budget every
 *    run on a domain whose DNS was never configured;
 *  - it stops rather than mass-deleting, because a short claim list is far more
 *    likely to mean a bad read than a genuine mass release.
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

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    site: { listCustomDomainRoutes: (...a: unknown[]) => listCustomDomainRoutes(...a) },
  },
  FlyCertService: {
    listCerts: (...a: unknown[]) => listCerts(...a),
    removeCert: (...a: unknown[]) => removeCert(...a),
  },
  isFlyCertsConfigured: () => isFlyCertsConfigured(),
}));

const { reconcileCustomDomainCerts } = await import('../customDomains.ts');

/** What the job reports back, for the assertions below. */
type ReconcileResult = {
  skipped: boolean;
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

  it('caps deletions per run instead of mass-deleting on a suspicious read', async () => {
    // If this wants to delete dozens at once, the likeliest explanation is that
    // the claim list came back short for a bad reason. Stopping is recoverable;
    // deleting live certificates is not.
    listCustomDomainRoutes.mockResolvedValue([]);
    listCerts.mockResolvedValue(Array.from({ length: 40 }, (_, i) => `orphan-${i}.example`));

    const result = await run();

    expect(removeCert).toHaveBeenCalledTimes(25);
    expect(result.removed).toHaveLength(25);
  });

  it('carries on past a hostname Fly refuses to delete', async () => {
    // One stubborn hostname must not abandon the sweep — it will still be
    // orphaned tomorrow, and tomorrow this runs again.
    listCustomDomainRoutes.mockResolvedValue([]);
    listCerts.mockResolvedValue(['a.example', 'b.example']);
    removeCert.mockRejectedValueOnce(new Error('fly down')).mockResolvedValueOnce(true);

    const result = await run();

    expect(result.failed).toEqual(['a.example']);
    expect(result.removed).toEqual(['b.example']);
  });
});
