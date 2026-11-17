/**
 * The page list's action (create, delete, toggle-menu, update-status) follows
 * the classroom-status rule the single-page action follows: in a LOCKED or
 * UNPUBLISHED classroom only the owner may change anything. Each change writes
 * one audit row.
 *
 * The decision is `pageMutationBlocked` (app/utils/auth.server.ts, the
 * platform rule from @classmoji/auth); what is pinned here is where the list
 * action applies it, by reading its source as the other gate specs do: after
 * the role gate, before the body is read and so before any intent writes.
 * Behaviour against a real database is exercised by the run-for-real check.
 *
 * Runs in the Playwright runner without a browser or the dev stack.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const LIST = source('../../app/routes/$classroomSlug/route.tsx');
const action = LIST.slice(LIST.indexOf('export const action = async'));

test('the rule runs after the role gate and before the body is read', () => {
  const roleGate = action.indexOf("if (!role || !['OWNER', 'TEACHER'].includes(role))");
  const rule = action.indexOf('const blocked = pageMutationBlocked(classroom, role);');
  const refused = action.indexOf('if (blocked) return blocked;');
  const body = action.indexOf('data = await request.json();');
  for (const at of [roleGate, rule, refused, body]) expect(at).toBeGreaterThan(-1);
  expect(roleGate).toBeLessThan(rule);
  expect(rule).toBeLessThan(refused);
  expect(refused).toBeLessThan(body);
});

test('every intent comes after the rule', () => {
  const rule = action.indexOf('if (blocked) return blocked;');
  expect(rule).toBeGreaterThan(-1);
  for (const intent of ['create', 'delete', 'toggle-menu', 'update-status']) {
    const at = action.indexOf(`intent === '${intent}'`);
    expect(at, intent).toBeGreaterThan(rule);
  }
});

test('each intent writes one audit row after its write', () => {
  const cases: Array<[string, string, string]> = [
    [
      'create',
      'await ClassmojiService.page.create(',
      "await audit('CREATE', page.id, 'pages.list.create'",
    ],
    [
      'delete',
      'await ClassmojiService.page.deletePage(data.pageId);',
      "await audit('DELETE', String(data.pageId), 'pages.list.delete'",
    ],
    [
      'toggle-menu',
      'await ClassmojiService.page.quickUpdate(data.pageId, {',
      "await audit('UPDATE', String(data.pageId), 'pages.list.toggle-menu'",
    ],
    [
      'update-status',
      'await ClassmojiService.page.quickUpdate(data.pageId, updates);',
      "await audit('UPDATE', String(data.pageId), 'pages.list.update-status'",
    ],
  ];
  for (const [intent, write, audited] of cases) {
    const branch = action.slice(action.indexOf(`if (intent === '${intent}')`));
    const writeAt = branch.indexOf(write);
    const auditAt = branch.indexOf(audited);
    expect(writeAt, intent).toBeGreaterThan(-1);
    expect(auditAt, intent).toBeGreaterThan(writeAt);
  }
  // Audit rows name the classroom the action resolved and the caller's role.
  const helper = action.slice(action.indexOf('const audit = async ('));
  expect(action.indexOf('const audit = async (')).toBeGreaterThan(-1);
  expect(helper).toContain('classroom_id: classroom.id,');
  expect(helper).toContain('user_id: authData.userId,');
  expect(helper).toContain("resource_type: 'PAGES',");
});

test('the status and menu rows record the new values', () => {
  const toggle = action.slice(action.indexOf("'pages.list.toggle-menu', {"));
  expect(toggle.slice(0, 200)).toContain('value: data.show,');
  const status = action.slice(action.indexOf("'pages.list.update-status', {"));
  expect(status.slice(0, 300)).toContain('is_draft: updates.is_draft');
  expect(status.slice(0, 300)).toContain('is_public: updates.is_public');
});
