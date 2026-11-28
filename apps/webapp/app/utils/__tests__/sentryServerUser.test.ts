/**
 * What the root loader hands Sentry about the person behind a request
 * (`setRequestUser`, utils/sentry.server.ts): their internal id, or, under
 * View as, no id at all (neither the viewed person's nor the admin's) and the
 * impersonating flag. `@classmoji/utils/sentry-node` is mocked: the
 * assertions are on what reaches it.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const setSentryUserId = vi.hoisted(() => vi.fn());
vi.mock('@classmoji/utils/sentry-node', () => ({
  initServerSentry: () => false,
  setSentryUserId,
  captureServerException: () => {},
}));

const { setRequestUser } = await import('../sentry.server');

beforeEach(() => setSentryUserId.mockReset());

it("names the signed-in person's own session by id", () => {
  setRequestUser({ userId: 'u1', session: { session: { id: 's1' }, user: { id: 'u1' } } });
  expect(setSentryUserId).toHaveBeenCalledWith('u1', { impersonating: false });
});

it('under View as names nobody, only the flag', () => {
  setRequestUser({
    userId: 'viewed-user',
    session: { session: { id: 's2', impersonatedBy: 'admin-1' }, user: { id: 'viewed-user' } },
  });
  expect(setSentryUserId).toHaveBeenCalledWith('viewed-user', { impersonating: true });
});

it('clears the user for a signed-out request', () => {
  setRequestUser(null);
  expect(setSentryUserId).toHaveBeenCalledWith(null, { impersonating: false });
});
