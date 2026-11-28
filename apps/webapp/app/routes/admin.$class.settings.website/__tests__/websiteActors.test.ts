/**
 * Website settings: every intent that changes the class site hands the site
 * service the actor its change is recorded for (the gate's owner, the tool
 * naming the intent, and the admin viewing as the owner), and the route writes
 * no audit row of its own. What each intent answers is unchanged, whether the
 * service wrote its row or missed it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertProTier: vi.fn(),
  requestImpersonator: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  validateAndClaimSubdomain: vi.fn(),
  upsertSiteSettings: vi.fn(),
  deleteSiteForClassroom: vi.fn(),
  setCustomDomain: vi.fn(),
  clearCustomDomain: vi.fn(),
}));

vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    site: {
      validateAndClaimSubdomain: (...a: unknown[]) => mocks.validateAndClaimSubdomain(...a),
      upsertSiteSettings: (...a: unknown[]) => mocks.upsertSiteSettings(...a),
      deleteSiteForClassroom: (...a: unknown[]) => mocks.deleteSiteForClassroom(...a),
      setCustomDomain: (...a: unknown[]) => mocks.setCustomDomain(...a),
      clearCustomDomain: (...a: unknown[]) => mocks.clearCustomDomain(...a),
    },
  },
  FlyCertService: { addCert: vi.fn(), getCertStatus: vi.fn() },
  // No certificate automation here, so a connected domain asks nothing of Fly.
  isFlyCertsConfigured: () => false,
}));

vi.mock('~/components', () => ({ SettingSection: () => null }));

const { action } = await import('../route');

const post = (intent: string, body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request(`http://x/admin/cs52/settings/website?/${intent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<Record<string, unknown>>;

const actor = (tool: string, impersonatedBy: string | null = null) => ({
  userId: 'owner-1',
  role: 'OWNER',
  tool,
  impersonatedBy,
});
const WRITTEN = { written: 1, missed: 0 };
const MISSED = { written: 0, missed: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.assertProTier.mockResolvedValue(undefined);
  mocks.requestImpersonator.mockResolvedValue(null);
  mocks.validateAndClaimSubdomain.mockResolvedValue({
    site: { id: 's1', subdomain: 'cs52' },
    audit: WRITTEN,
  });
  mocks.upsertSiteSettings.mockResolvedValue({ site: { id: 's1' }, audit: WRITTEN });
  mocks.deleteSiteForClassroom.mockResolvedValue({
    removed: { id: 's1', subdomain: 'cs52', custom_domain: null },
    audit: WRITTEN,
  });
  mocks.setCustomDomain.mockResolvedValue({
    site: { id: 's1', custom_domain: 'cs52.me' },
    audit: WRITTEN,
  });
  mocks.clearCustomDomain.mockResolvedValue({ released: 'cs52.me', audit: WRITTEN });
});

describe('website settings: the site service records each change', () => {
  it('claimSubdomain', async () => {
    expect(await post('claimSubdomain', { subdomain: 'cs52' })).toEqual({
      success: 'Claimed cs52',
    });
    expect(mocks.validateAndClaimSubdomain).toHaveBeenCalledExactlyOnceWith(
      'c1',
      'cs52',
      actor('web:settings.website.claim_subdomain')
    );
  });

  it('saveSettings passes only the submitted keys', async () => {
    expect(await post('saveSettings', { show_schedule: false, subdomain: 'x' })).toEqual({
      success: 'Website settings updated',
    });
    expect(mocks.upsertSiteSettings).toHaveBeenCalledExactlyOnceWith(
      'c1',
      { show_schedule: false },
      actor('web:settings.website.save')
    );
  });

  it('removeSite', async () => {
    expect(await post('removeSite', {})).toEqual({
      success: 'Site removed — cs52 is free again',
    });
    expect(mocks.deleteSiteForClassroom).toHaveBeenCalledExactlyOnceWith(
      'c1',
      actor('web:settings.website.remove_site')
    );
  });

  it('saveCustomDomain', async () => {
    expect(await post('saveCustomDomain', { custom_domain: 'cs52.me' })).toEqual({
      success: 'Connected cs52.me',
      certError: 'NOT_CONFIGURED',
    });
    expect(mocks.setCustomDomain).toHaveBeenCalledExactlyOnceWith(
      'c1',
      'cs52.me',
      actor('web:settings.website.custom_domain')
    );
  });

  it('removeCustomDomain', async () => {
    expect(await post('removeCustomDomain', {})).toEqual({
      success: 'Disconnected cs52.me — you can remove its DNS records now',
    });
    expect(mocks.clearCustomDomain).toHaveBeenCalledExactlyOnceWith(
      'c1',
      actor('web:settings.website.remove_custom_domain')
    );
  });

  it('passes the admin viewing as the owner', async () => {
    mocks.requestImpersonator.mockResolvedValue('admin-3');
    await post('saveSettings', { is_enabled: true });
    expect(mocks.upsertSiteSettings.mock.calls[0][2]).toEqual(
      actor('web:settings.website.save', 'admin-3')
    );
  });

  it('answers the same when a row was missed, and writes no row itself', async () => {
    mocks.validateAndClaimSubdomain.mockResolvedValue({
      site: { id: 's1', subdomain: 'cs52' },
      audit: MISSED,
    });
    mocks.clearCustomDomain.mockResolvedValue({ released: null, audit: MISSED });
    expect(await post('claimSubdomain', { subdomain: 'cs52' })).toEqual({
      success: 'Claimed cs52',
    });
    expect(await post('removeCustomDomain', {})).toEqual({
      success: 'No custom domain was connected',
    });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('a lapsed Pro plan reaches no custom domain change', async () => {
    mocks.assertProTier.mockRejectedValue(new Response(null, { status: 403 }));
    expect(await post('saveCustomDomain', { custom_domain: 'cs52.me' })).toEqual({
      error: 'Custom domains require an active Pro subscription.',
      code: 'PRO_REQUIRED',
    });
    expect(mocks.setCustomDomain).not.toHaveBeenCalled();
  });
});
