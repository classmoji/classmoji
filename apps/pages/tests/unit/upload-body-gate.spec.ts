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

  test('the editor toasts every refusal before BlockNote swallows it', () => {
    // BlockNote's upload tab turns any thrown error into "Upload failed", so
    // the reason reaches the person only through the toast.
    const upload = EDITOR_SOURCE.slice(EDITOR_SOURCE.indexOf('const uploadFile = useCallback('));
    expect(upload).toContain('toast.error(message);\n        throw new Error(message);');
    expect(upload).toContain('refuse(repoFileTooLargeMessage(file.name));');
    expect(upload).toContain("refuse(typeof body?.error === 'string' ? body.error : 'Upload failed');");
    expect(upload.slice(0, upload.indexOf('return result.url;'))).not.toContain('throw new Error(repo');
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

  test('the page action reads a JSON save capped, after the same gates', () => {
    const action = PAGE_ACTION_SOURCE.slice(PAGE_ACTION_SOURCE.indexOf('export const action'));
    const status = action.indexOf('pageMutationBlocked(page.classroom, membership.role)');
    const read = action.indexOf('data = await readPageJsonBody(request);');

    for (const at of [status, read]) expect(at).toBeGreaterThan(-1);
    expect(status).toBeLessThan(read);
    expect(action).not.toContain('await request.json()');
    // Twice the repository's file cap: the document rides as an escaped string.
    expect(PAGE_ACTION_SOURCE).toContain(
      'const PAGE_JSON_BODY_MAX_BYTES = 2 * REPO_REST_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;'
    );
    expect(PAGE_ACTION_SOURCE).toContain(
      'const bytes = await readLimitedBody(request.body, PAGE_JSON_BODY_MAX_BYTES);'
    );
  });
});
