import { test, expect } from '@playwright/test';

import { classifyFormsPath, siteFormsBridgePath } from '../../app/utils/formsPaths.ts';

/**
 * The class-site short-link bridge's decision, as a pure function.
 *
 * ── Why this is unit-tested and not only exercised over HTTP ───────────────
 * The e2e in `forms-site-link.spec.ts` asserts the 302 for real, but it can
 * only do that against a server with SITE_BASE_DOMAIN configured, which the
 * ordinary dev stack deliberately is not (a `.lvh.me` cookie domain breaks
 * localhost logins). So on most runs the HTTP assertions skip and THIS file is
 * the coverage — which is the same arrangement `site-host.spec.ts` and
 * `forms-paths.spec.ts` already make for the two other decisions in this
 * subtree that are pure by design.
 *
 * The property that matters most here is the REFUSAL: the function's output
 * lands in a `Location` header, so anything it does not recognize has to come
 * back null rather than be forwarded and hoped for.
 */

test.describe('siteFormsBridgePath — the public fill surfaces', () => {
  test('a bare form slug bridges', () => {
    expect(siteFormsBridgePath('cs52-waitlist')).toBe('cs52-waitlist');
  });

  test('the magic-link review page bridges', () => {
    expect(siteFormsBridgePath('cs52-waitlist/verify')).toBe('cs52-waitlist/verify');
  });

  test('the delivery poll bridges', () => {
    // Classified 'admin' by the auth gate and bridged anyway — see the comment
    // on BRIDGED_FORM_SUBPATHS. The two sets answer different questions, and
    // this assertion is what would notice them being collapsed into one.
    expect(classifyFormsPath('/cs52/forms/w/delivery')).toBe('admin');
    expect(siteFormsBridgePath('cs52-waitlist/delivery')).toBe('cs52-waitlist/delivery');
  });

  test('a subpath whose case a mail client touched still resolves', () => {
    expect(siteFormsBridgePath('cs52-waitlist/VERIFY')).toBe('cs52-waitlist/verify');
  });

  test('a trailing or doubled slash does not change the answer', () => {
    expect(siteFormsBridgePath('cs52-waitlist/')).toBe('cs52-waitlist');
    expect(siteFormsBridgePath('cs52-waitlist//verify')).toBe('cs52-waitlist/verify');
  });
});

test.describe('siteFormsBridgePath — everything it refuses', () => {
  test('the admin list is not bridged', () => {
    // The empty splat: `{subdomain}.classmoji.io/forms` itself.
    expect(siteFormsBridgePath('')).toBeNull();
    expect(siteFormsBridgePath('/')).toBeNull();
  });

  test('the admin surfaces under a form are not bridged', () => {
    expect(siteFormsBridgePath('new')).toBeNull();
    expect(siteFormsBridgePath('cs52-waitlist/edit')).toBeNull();
    expect(siteFormsBridgePath('cs52-waitlist/responses')).toBeNull();
    expect(siteFormsBridgePath('cs52-waitlist/responses/export')).toBeNull();
  });

  test('an unknown subpath is refused rather than forwarded', () => {
    // Default deny. A route added under the subtree later is not bridged until
    // somebody lists it, which is the safe end of the ambiguity.
    expect(siteFormsBridgePath('cs52-waitlist/whatever')).toBeNull();
  });

  test('a slug that is not a slug is refused', () => {
    // Everything here would otherwise be spliced into a Location header. The
    // splat arrives DECODED, so these are the shapes that matter: a smuggled
    // separator, an absolute URL, a scheme, whitespace, uppercase.
    for (const rest of [
      '..',
      'a/../../etc',
      'waitlist?x=1',
      'waitlist#x',
      'https://evil.example',
      'evil.example',
      'wait list',
      'Waitlist',
      'wait_list',
      'wait%2flist',
      '-leading',
      'trailing-',
      // titleToIdentifier collapses hyphen runs, so no real slug looks like this.
      'double--hyphen',
    ]) {
      expect(siteFormsBridgePath(rest), `${rest} must not bridge`).toBeNull();
    }
  });

  test('a protocol-relative slug cannot become an off-site redirect', () => {
    // `//evil.example` as the rest would make the Location protocol-relative if
    // it were ever concatenated raw. It is two empty segments plus a host, and
    // the host fails the slug check.
    expect(siteFormsBridgePath('//evil.example')).toBeNull();
    expect(siteFormsBridgePath('/\\evil.example')).toBeNull();
  });
});
