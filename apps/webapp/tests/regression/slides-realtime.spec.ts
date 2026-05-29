import { test } from '../fixtures/auth.fixture';

/**
 * Slides realtime presenter sync + `redirect` event (RW-09).
 *
 * This item belongs to the apps/slides Playwright project, which owns the
 * Socket.IO server and socket test helper; the webapp project has no Socket.IO
 * client to drive the /multiplex namespace. The core sync/error contract is
 * already covered by apps/slides/tests/e2e/slides-multiplex-sync.spec.ts, and
 * the `redirect` socket emit does not yet exist in the Socket.IO layer.
 */

test.describe('REGRESSION: slides realtime multiplex still works after TS migration', () => {
  test.fixme(
    true,
    'MISSING: (1) belongs to the apps/slides Playwright project + socket helper, not the webapp project — core sync/error contract is already covered by apps/slides/tests/e2e/slides-multiplex-sync.spec.ts; (2) the NEW `redirect` socket emit is not present in apps/slides/server.ts or apps/slides/app, so client-navigation-on-redirect cannot be grounded. Needs the redirect emit to exist (or a pointer to where it lives) and a slides-project spec.'
  );
});
