/**
 * The top bar: the pages app's way back to the webapp (#669).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack. They
 * pin the two rules the bar's links depend on, by reading the modules' source:
 * the class link is built on the server from the role the loader resolved
 * (each role has its own webapp route tree, and `/admin` is OWNER-only), and
 * the bar is part of the full layout only, never the webapp's reader frame.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { webappClassUrl } from '@classmoji/utils/webapp-links';

import { cameFromPath } from '../../app/utils/cameFrom.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const LAYOUT = source('../../app/routes/$classroomSlug/route.tsx');
const TOP_BAR = source('../../app/components/layout/TopBar.tsx');

test.describe('the class link', () => {
  test("lands on the class dashboard in each role's own tree", () => {
    const web = 'https://app.example.org';
    expect(webappClassUrl(web, 'OWNER', 'cs1', 'dashboard')).toBe(`${web}/admin/cs1/dashboard`);
    expect(webappClassUrl(web, 'TEACHER', 'cs1', 'dashboard')).toBe(`${web}/teacher/cs1/dashboard`);
    expect(webappClassUrl(web, 'ASSISTANT', 'cs1', 'dashboard')).toBe(
      `${web}/assistant/cs1/dashboard`
    );
    expect(webappClassUrl(web, 'STUDENT', 'cs1', 'dashboard')).toBe(`${web}/student/cs1/dashboard`);
  });

  test('is built by the loader from the resolved membership, and only for members', () => {
    expect(LAYOUT).toContain(
      "? webappClassUrl(webappUrl, membership.role, classroom.slug, 'dashboard')"
    );
    expect(LAYOUT).toContain('const classHomeUrl = membership');
    // A member goes back where they came from, else to the dashboard; a reader
    // with no session gets sign-in; a signed-in non-member plain text.
    expect(LAYOUT).toContain(
      'const classLinkUrl = classHomeUrl && cameFrom ? `${webappUrl}${cameFrom}` : classHomeUrl;'
    );
    expect(TOP_BAR).toContain(
      'const signInHref = !user && !classHomeUrl ? `${webappUrl}/` : null;'
    );
    expect(TOP_BAR).toContain('{classHref ? (');
  });
});

test.describe('where the reader came from (?from=)', () => {
  test('accepts a page of this classroom in any role tree', () => {
    expect(cameFromPath('/student/cs1/modules', 'cs1')).toBe('/student/cs1/modules');
    expect(cameFromPath('/admin/cs1/calendar?view=week', 'cs1')).toBe(
      '/admin/cs1/calendar?view=week'
    );
    expect(cameFromPath('/teacher/cs1', 'cs1')).toBe('/teacher/cs1');
    expect(cameFromPath('/assistant/cs1/assignments/a-1', 'cs1')).toBe(
      '/assistant/cs1/assignments/a-1'
    );
  });

  test("refuses another classroom's pages and anything outside the role trees", () => {
    expect(cameFromPath('/student/cs2/modules', 'cs1')).toBeNull();
    expect(cameFromPath('/student/cs10/modules', 'cs1')).toBeNull();
    expect(cameFromPath('/logout', 'cs1')).toBeNull();
    expect(cameFromPath('/settings/general', 'cs1')).toBeNull();
    expect(cameFromPath('/student', 'cs1')).toBeNull();
  });

  test('refuses other hosts and paths a browser would rewrite', () => {
    for (const raw of [
      'https://evil.test/student/cs1',
      '//evil.test/student/cs1',
      `/student/cs1/${String.fromCharCode(0x5c)}x`,
      '/student/cs1/../../logout',
      '/student/cs1/%2e%2e/x',
      '/student/cs1/a b',
      `/student/cs1/${String.fromCharCode(0x6f22)}`,
      'student/cs1',
      '',
      '/student/cs1/' + 'a'.repeat(600),
    ]) {
      expect(cameFromPath(raw, 'cs1')).toBeNull();
    }
    expect(cameFromPath(null, 'cs1')).toBeNull();
    expect(cameFromPath(42, 'cs1')).toBeNull();
  });

  test('is read once per landing, kept per tab, and only outside the reader frame', () => {
    expect(LAYOUT).toContain('if (isEmbedded || framed || typeof window ===');
    expect(LAYOUT).toContain('window.sessionStorage.setItem(key, fromParam)');
    expect(LAYOUT).toContain('url.searchParams.delete(CAME_FROM_PARAM)');
  });
});

test.describe('where the bar is mounted', () => {
  test('in the full layout, after the embedded branch has returned', () => {
    const embeddedBranch = LAYOUT.indexOf('if (isEmbedded || framed) {');
    const fullLayout = LAYOUT.indexOf('return (\n    <PagesLayout', embeddedBranch);
    const bar = LAYOUT.indexOf('<TopBar');
    expect(embeddedBranch).toBeGreaterThan(0);
    expect(fullLayout).toBeGreaterThan(embeddedBranch);
    expect(LAYOUT.match(/<TopBar/g)).toHaveLength(1);
    expect(bar).toBeGreaterThan(fullLayout);
  });
});
