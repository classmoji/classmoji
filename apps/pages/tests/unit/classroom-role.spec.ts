/**
 * A member can hold several rows in one classroom (an owner also enrolled as a
 * student), and every place in this app that reads "their role" must pick the
 * same one — the highest. Otherwise the editor opens read-only for an owner,
 * or opens for editing and then refuses the save, and the download map and
 * route disagree with it.
 *
 * `highestRole` is pure and runs here; the places that use it need Postgres to
 * run, so their use of it is pinned from source (the media-downloads.spec
 * approach).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { highestRole } from '~/utils/classroomRole.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test.describe('highestRole', () => {
  test('the most privileged role wins, whatever order the rows come back in', () => {
    expect(highestRole(['STUDENT', 'OWNER', 'ASSISTANT'])).toBe('OWNER');
    expect(highestRole(['ASSISTANT', 'STUDENT'])).toBe('ASSISTANT');
    expect(highestRole(['STUDENT', 'TEACHER'])).toBe('TEACHER');
    expect(highestRole(['STUDENT'])).toBe('STUDENT');
  });

  test('no rows is no role', () => {
    expect(highestRole([])).toBeNull();
  });
});

test.describe('every reader of a member’s role asks the same helper', () => {
  const PAGE_ROUTE = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
  const AUTH = source('../../app/utils/auth.server.ts');
  // The app's helper re-exports the shared one; the rule lives there.
  const APP_HELPER = source('../../app/utils/classroomRole.server.ts');
  const HELPER = source('../../../../packages/auth/src/classroomRole.ts');
  const TENANT = source('../../app/site/tenant.server.ts');

  test('the page loader and its save action', () => {
    expect(PAGE_ROUTE).not.toContain('findByClassroomAndUser');
    // The loader's role, its save action's, and the download map's (accepted only).
    expect(PAGE_ROUTE.match(/await findClassroomRole\(\{/g)).toHaveLength(3);
    expect(PAGE_ROUTE.match(/acceptedOnly: true,/g)).toHaveLength(1);
  });

  test('assertPageAccess, which the download route reads its role from', () => {
    expect(AUTH).not.toMatch(/classroomMembership\.findFirst/);
    expect(AUTH).toContain('const role = await findClassroomRole({');
    expect(AUTH).toContain('acceptedOnly,');
  });

  test('the helper reads every row and picks the highest; the class site does too', () => {
    expect(APP_HELPER).toContain("from '@classmoji/auth/classroom-role'");
    expect(HELPER).toContain('getPrisma().classroomMembership.findMany({');
    expect(HELPER).toContain('return highestRole(rows.map(row => row.role));');
    expect(HELPER).toContain('...(acceptedOnly ? { has_accepted_invite: true } : {}),');
    expect(TENANT).toContain('highestRole(memberships.map(membership => membership.role))');
  });

  test('the classroom index, its action, the pages API and the form fill', () => {
    for (const relative of [
      '../../app/routes/$classroomSlug/route.tsx',
      '../../app/routes/api.pages.$classroomSlug/route.ts',
      '../../app/forms/fill/classroomForm.server.ts',
    ]) {
      const text = source(relative);
      expect(text, relative).toContain(
        "import { findClassroomRole } from '~/utils/classroomRole.server.ts';"
      );
      // The default: every row, accepted or not, as these always counted.
      expect(text, relative).not.toContain('acceptedOnly');
    }
    const index = source('../../app/routes/$classroomSlug/route.tsx');
    // The loader and the action gate.
    expect(index.match(/await findClassroomRole\(\{/g)).toHaveLength(2);
    expect(index).toContain("if (!role || !['OWNER', 'TEACHER'].includes(role)) {");
  });

  test('nothing in the app picks one of a member’s rows by itself', () => {
    const root = fileURLToPath(new URL('../../app/', import.meta.url));
    const files = (readdirSync(root, { recursive: true }) as string[]).filter(file =>
      /\.(ts|tsx)$/.test(file)
    );
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8');
      // `site/tenant.server.ts` names the service method in a comment only.
      expect(text.replace(/^\s*(\*|\/\/).*$/gm, ''), file).not.toContain('findByClassroomAndUser');
      expect(text, file).not.toMatch(/classroomMembership\.findFirst/);
    }
  });
});
