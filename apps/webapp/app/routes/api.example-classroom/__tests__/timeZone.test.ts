/**
 * The onboarding tour posts the browser zone; the route forwards it to the
 * provisioner (which validates it). An empty body must still work.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const provision = vi.fn();

vi.mock('@classmoji/auth/server', () => ({ requireAuth: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('@classmoji/database', () => ({
  default: () => ({ user: { findUnique: vi.fn(async () => ({ login: 'tim' })) } }),
}));
vi.mock('@classmoji/services', () => ({
  provisionExampleClassroom: (...a: unknown[]) => provision(...a),
}));

const { action } = await import('../route');

const post = (body?: FormData) =>
  action({
    request: new Request('http://x/api/example-classroom', { method: 'POST', body }),
  } as never);

beforeEach(() => {
  provision.mockReset();
  provision.mockResolvedValue({ id: 'c1', slug: 'example-tim' });
});

describe('POST /api/example-classroom time zone', () => {
  it('forwards the browser zone from the tour', async () => {
    const form = new FormData();
    form.append('timezone', 'America/New_York');
    await post(form);
    expect(provision).toHaveBeenCalledWith({
      ownerUserId: 'u1',
      ownerLogin: 'tim',
      timezone: 'America/New_York',
    });
  });

  it('still provisions with no body at all', async () => {
    const res = (await post()) as Response;
    expect(res.status).toBe(200);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ timezone: null }));
  });
});
