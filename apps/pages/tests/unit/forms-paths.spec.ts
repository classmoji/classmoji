/**
 * Unit tests for the forms path classifier (app/utils/formsPaths.ts).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module under test is pure. It carries a security boundary: it is the function
 * that decides which paths `root.tsx` stops requiring a session for, so the
 * properties that matter are
 *
 *  - the ONLY exempted shapes are the public fill surfaces;
 *  - every admin surface, and every shape nobody has invented yet, classifies
 *    as admin and therefore still requires a session;
 *  - nothing outside `/{classroomSlug}/forms/**` is affected at all, so the
 *    page-view branch of the gate keeps working unchanged;
 *  - the answer does not change between a document request and React Router's
 *    `.data` fetch for the same route.
 *
 * A companion e2e spec (tests/e2e/forms-auth-gate.spec.ts) asserts the HTTP
 * behaviour these classifications are supposed to produce. This file asserts
 * the rule; that one asserts the wiring.
 */

import { test, expect } from '@playwright/test';
import { classifyFormsPath, isFormsPath, isPublicFormsPath } from '../../app/utils/formsPaths.ts';

test.describe('classifyFormsPath — outside the subtree', () => {
  test('returns null for paths that are not forms paths', () => {
    for (const path of [
      '/',
      '/health',
      '/api/pages/cs52',
      '/cs52',
      '/cs52/some-page-id',
      '/_site/cs52/syllabus',
      '/test-login',
    ]) {
      expect(classifyFormsPath(path), path).toBeNull();
      expect(isFormsPath(path), path).toBe(false);
    }
  });

  test('a classroom whose slug is literally "forms" is not a forms path', () => {
    // `/forms/waitlist` has 'forms' in the FIRST segment, where the classroom
    // slug lives — it is a page view, not a form.
    expect(classifyFormsPath('/forms/waitlist')).toBeNull();
  });

  test('a page whose id is "forms" still resolves as a forms path, by design', () => {
    // `/cs52/forms` is unreachable as a page view once forms exist: the route
    // config gives the static segment to the forms list. Classifying it here is
    // what stops the gate from running a Page lookup for the id 'forms'.
    expect(classifyFormsPath('/cs52/forms')).toBe('admin');
  });
});

test.describe('classifyFormsPath — admin surfaces require a session', () => {
  const adminPaths = [
    '/cs52/forms',
    '/cs52/forms/',
    '/cs52/forms/new',
    '/cs52/forms/waitlist/edit',
    '/cs52/forms/waitlist/responses',
    '/cs52/forms/waitlist/responses/abc123',
    '/cs52/forms/waitlist/something-nobody-has-built-yet',
    '/cs52/forms/a/b/c/d/e',
  ];

  for (const path of adminPaths) {
    test(`${path} → admin`, () => {
      expect(classifyFormsPath(path)).toBe('admin');
      expect(isPublicFormsPath(path)).toBe(false);
    });
  }

  test('an unrecognized shape fails CLOSED', () => {
    // The property, stated as a property rather than as a list: anything the
    // classifier does not explicitly recognize as public is admin. If this ever
    // flips to "unknown means public", every future route under the subtree
    // becomes anonymous the day it is added.
    expect(classifyFormsPath('/cs52/forms/waitlist/edit/deeper/still')).toBe('admin');
    expect(classifyFormsPath('/cs52/forms/waitlist/verify/extra')).toBe('admin');
  });
});

test.describe('classifyFormsPath — public fill surfaces are exempt', () => {
  const publicPaths = [
    '/cs52/forms/waitlist',
    '/cs52/forms/waitlist/',
    '/cs52/forms/26w-planning-survey',
    '/cs52/forms/waitlist/verify',
    '/cs52/forms/waitlist/verify/',
  ];

  for (const path of publicPaths) {
    test(`${path} → public`, () => {
      expect(classifyFormsPath(path)).toBe('public');
      expect(isPublicFormsPath(path)).toBe(true);
    });
  }

  test('`new` is the admin drawer, never a form slug', () => {
    // `new`, `edit` and `responses` are refused as slugs at create
    // (RESERVED_FORM_SLUGS in form.service), so a real form can never claim
    // this path and the static reading is unambiguous.
    expect(classifyFormsPath('/cs52/forms/new')).toBe('admin');
  });
});

test.describe('classifyFormsPath — normalization', () => {
  test('React Router .data requests classify like their documents', () => {
    // A client-side navigation fetches `<path>.data`. If that were classified
    // differently, the first (document) render would be public and every
    // subsequent navigation would demand a login.
    expect(classifyFormsPath('/cs52/forms/waitlist.data')).toBe('public');
    expect(classifyFormsPath('/cs52/forms/waitlist/verify.data')).toBe('public');
    expect(classifyFormsPath('/cs52/forms.data')).toBe('admin');
    expect(classifyFormsPath('/cs52/forms/waitlist/edit.data')).toBe('admin');
  });

  test('doubled and trailing slashes do not change the answer', () => {
    expect(classifyFormsPath('/cs52//forms//waitlist')).toBe('public');
    expect(classifyFormsPath('/cs52/forms//')).toBe('admin');
  });

  /**
   * The ROUTER matches these case-insensitively. This function did not, and it
   * disagreed with the router in both directions at once:
   *
   *  - `/cs52/forms/NEW` served the admin new-form drawer and classified as
   *    PUBLIC, exempting an admin surface from the login redirect;
   *  - `/cs52/forms/waitlist/VERIFY` served the magic-link review page and
   *    classified as ADMIN, so a link whose case a mail client had touched
   *    demanded a Classmoji account from a person who has never had one.
   *
   * Two different failures, one cause: a gate that does not agree with the
   * router about which page it is guarding.
   */
  test('the subpath names are matched the way the router matches them', () => {
    for (const spelling of ['new', 'NEW', 'New', 'nEw']) {
      expect(classifyFormsPath(`/cs52/forms/${spelling}`), spelling).toBe('admin');
    }
    for (const spelling of ['verify', 'VERIFY', 'Verify']) {
      expect(classifyFormsPath(`/cs52/forms/waitlist/${spelling}`), spelling).toBe('public');
    }
    for (const spelling of ['forms', 'FORMS', 'Forms']) {
      expect(classifyFormsPath(`/cs52/${spelling}/waitlist`), spelling).toBe('public');
      expect(classifyFormsPath(`/cs52/${spelling}`), spelling).toBe('admin');
    }
    // An ordinary slug is still a slug whatever its case — folding the subpath
    // names must not start folding form slugs into reserved words.
    expect(classifyFormsPath('/cs52/forms/Waitlist')).toBe('public');
    expect(classifyFormsPath('/cs52/forms/waitlist/EDIT')).toBe('admin');
  });

  test('a percent-encoded segment is not read as "forms"', () => {
    // Segments are compared raw. `%66orms` decodes to `forms`, and accepting it
    // would mean two spellings of the same path with one exemption between
    // them. Falling through to null puts it back on the ordinary auth path.
    expect(classifyFormsPath('/cs52/%66orms/waitlist')).toBeNull();
  });
});
