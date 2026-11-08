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
    // A reader with no membership (a public page) gets plain text, not a link.
    expect(TOP_BAR).toContain('{classHomeUrl ? (');
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
