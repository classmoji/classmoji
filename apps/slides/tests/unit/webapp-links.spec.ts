/**
 * Unit tests for the back-links this app builds into the webapp.
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module under test is pure string building.
 *
 * Contract pinned here: each role gets the route tree its own role can open.
 * The webapp keeps one tree per role and gates each to that role, so folding
 * teachers or assistants into `/admin` (which is OWNER-only) produces a link
 * that lands on a permission error rather than the page.
 */

import { test, expect } from '@playwright/test';

import { webappClassPath, webappRolePrefix } from '../../app/utils/webappLinks.ts';

test.describe('role → webapp route tree', () => {
  test('owners go to the admin tree', () => {
    expect(webappRolePrefix('OWNER')).toBe('admin');
  });

  test('teachers have their own tree', () => {
    expect(webappRolePrefix('TEACHER')).toBe('teacher');
  });

  test('assistants have their own tree', () => {
    expect(webappRolePrefix('ASSISTANT')).toBe('assistant');
  });

  test('students go to the student tree', () => {
    expect(webappRolePrefix('STUDENT')).toBe('student');
  });

  test('an unresolved role falls back to the student tree, never admin', () => {
    // The fallback has to be the narrowest tree. Guessing `admin` would point
    // at the OWNER-gated one, which is the failure this helper exists to stop.
    expect(webappRolePrefix(null)).toBe('student');
    expect(webappRolePrefix(undefined)).toBe('student');
    expect(webappRolePrefix('SOMETHING_NEW')).toBe('student');
  });
});

test.describe('classroom section paths', () => {
  test('a path carries the role prefix, the slug and the section', () => {
    expect(webappClassPath('TEACHER', 'cs52', 'slides')).toBe('/teacher/cs52/slides');
    expect(webappClassPath('OWNER', 'cs52', 'slides')).toBe('/admin/cs52/slides');
    expect(webappClassPath('ASSISTANT', 'cs52', 'slides')).toBe('/assistant/cs52/slides');
  });
});
