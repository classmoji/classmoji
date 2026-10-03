/**
 * `canServeSignedContent` — the one answer to "will this classroom's content
 * come back signed on this deployment", which media uploads are offered on
 * and refused on.
 *
 * Both halves, because the classroom half alone says yes on a deployment with
 * no signing secret or delivery origin — where a media page offered Upload and
 * `createUpload` then refused every file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const { canDeliverContent, canServeSignedContent, uploadFileTypes } =
  await import('../contentDelivery.service.ts');

const DELIVERABLE = {
  content_delivery_enabled: true,
  content_repo: 'content',
  git_organization: { login: 'org', provider: 'GITHUB', github_installation_id: '42' },
};

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ['CONTENT_SIGNING_SECRET', 'CONTENT_DELIVERY_ORIGIN']) {
    saved[key] = process.env[key];
  }
  process.env.CONTENT_SIGNING_SECRET = 'secret';
  process.env.CONTENT_DELIVERY_ORIGIN = 'https://content.example';
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('canServeSignedContent', () => {
  it('is true for a deliverable classroom on a deployment that can sign', () => {
    expect(canServeSignedContent(DELIVERABLE)).toBe(true);
  });

  it('is false on a deployment without the signing secret or the origin, whatever the classroom', () => {
    for (const key of ['CONTENT_SIGNING_SECRET', 'CONTENT_DELIVERY_ORIGIN']) {
      const value = process.env[key];
      delete process.env[key];
      // The classroom half alone still says yes — the gap this closes.
      expect(canDeliverContent(DELIVERABLE), key).toBe(true);
      expect(canServeSignedContent(DELIVERABLE), key).toBe(false);
      expect(uploadFileTypes(DELIVERABLE), key).toBe('allowlist');
      process.env[key] = value;
    }
  });

  it('is false for a classroom the layer does not deliver', () => {
    expect(canServeSignedContent({ ...DELIVERABLE, content_delivery_enabled: false })).toBe(false);
    expect(canServeSignedContent({ ...DELIVERABLE, git_organization: null })).toBe(false);
    expect(canServeSignedContent(null)).toBe(false);
  });
});
