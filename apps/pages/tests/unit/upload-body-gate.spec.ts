/**
 * Every multipart upload into a page reads its body only after the gate that
 * decides who may upload, and through the byte-counting reader.
 *
 * The routes need Postgres and a content repo to run, so what is pinned here is
 * their ORDER, read from source — the same approach the slides app takes for
 * its upload routes. Getting it wrong is silent: an action that parsed the
 * body first still passes every functional test, and buffers whatever a
 * stranger sends before refusing them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const UPLOAD_SOURCE = source('../../app/routes/api.upload/route.ts');
const PAGE_ACTION_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
const EDITOR_SOURCE = source('../../app/components/editor/PageEditor.tsx');

test.describe('page uploads read the body after the gate', () => {
  test('api.upload names the page in the URL and authorizes before reading', () => {
    const pageFromUrl = UPLOAD_SOURCE.indexOf("new URL(request.url).searchParams.get('pageId')");
    const gate = UPLOAD_SOURCE.indexOf(
      "await assertPageAccess({ request, page, accessType: 'edit' })"
    );
    const status = UPLOAD_SOURCE.indexOf('pageMutationBlocked(');
    const read = UPLOAD_SOURCE.indexOf('await readLimitedFormData(request, uploadBodyLimit(');

    for (const at of [pageFromUrl, gate, status, read]) expect(at).toBeGreaterThan(-1);
    expect(pageFromUrl).toBeLessThan(gate);
    expect(gate).toBeLessThan(read);
    expect(status).toBeLessThan(read);
    expect(UPLOAD_SOURCE).not.toContain('await request.formData()');
  });

  test('the editor sends the page in the query string, not the form', () => {
    expect(EDITOR_SOURCE).toContain('/api/upload?pageId=${encodeURIComponent(pageId)}');
    expect(EDITOR_SOURCE).not.toContain("formData.append('pageId'");
  });

  test('the page action reads a multipart body only after membership and status', () => {
    const action = PAGE_ACTION_SOURCE.slice(PAGE_ACTION_SOURCE.indexOf('export const action'));
    const membership = action.indexOf('classroomMembership.findByClassroomAndUser(');
    const status = action.indexOf('pageMutationBlocked(page.classroom, membership.role)');
    const read = action.indexOf('await readLimitedFormData(request, uploadBodyLimit(');

    for (const at of [membership, status, read]) expect(at).toBeGreaterThan(-1);
    expect(membership).toBeLessThan(read);
    expect(status).toBeLessThan(read);
    expect(action).not.toContain('await request.formData()');
  });
});
