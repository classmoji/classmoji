import { test, expect } from '../fixtures/auth.fixture';
import { TEST_CLASSROOM } from '../helpers/env.helpers';
import { getClassroomBySlug, getUserByLogin } from '../helpers/prisma.helpers';
import { requestAs } from '../helpers/request.helpers';

/**
 * Regression: API authorization guards across api.$operation
 * (get-org-subscription, get-user-by-id) and
 * api.gitRepoAssignment (autograde).
 *
 * assertClassroomAccess throws a 403 Response on role/membership denial, and
 * 400 for missing required params. requestAs(role) issues API calls under each
 * role's storageState:
 *   owner     = prof-classmoji (OWNER + ASSISTANT + STUDENT)
 *   assistant = fake-ta        (ASSISTANT only)
 *   student   = fake-student-1 (STUDENT only)
 */

test.describe('REGRESSION: api.$operation get-org-subscription still works after TS migration', () => {
  test('owner reads org subscription JSON and a missing orgLogin returns 400', async ({
    authenticatedPage: page,
  }) => {
    const ok = await page.request.get(
      `/api/get-org-subscription?orgLogin=${TEST_CLASSROOM}`
    );
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body).toBeTruthy();
    expect(typeof body).toBe('object');
    expect(body.error).toBeUndefined();

    const missing = await page.request.get('/api/get-org-subscription');
    expect(missing.status()).toBe(400);
    expect((await missing.json()).error).toMatch(/orgLogin/i);
  });

  test('a non-owner (student, assistant) is denied the org subscription with 403 (RW-04 IDOR)', async () => {
    const student = await requestAs('student');
    const studentRes = await student.get(
      `/api/get-org-subscription?orgLogin=${TEST_CLASSROOM}`
    );
    expect(studentRes.status()).toBe(403);
    await student.dispose();

    const assistant = await requestAs('assistant');
    const assistantRes = await assistant.get(
      `/api/get-org-subscription?orgLogin=${TEST_CLASSROOM}`
    );
    expect(assistantRes.status()).toBe(403);
    await assistant.dispose();
  });
});

test.describe('REGRESSION: api.$operation get-user-by-id still works after TS migration', () => {
  test('owner gets only safe fields and missing params return 400/404', async ({
    authenticatedPage: page,
  }) => {
    const classroom = await getClassroomBySlug(TEST_CLASSROOM);
    const user = await getUserByLogin('prof-classmoji');

    const noUser = await page.request.get(
      `/api/get-user-by-id?orgLogin=${TEST_CLASSROOM}`
    );
    expect(noUser.status()).toBe(400);
    expect((await noUser.json()).error).toMatch(/userId/i);

    const noOrg = await page.request.get(
      `/api/get-user-by-id?userId=${user.id}`
    );
    expect(noOrg.status()).toBe(400);
    expect((await noOrg.json()).error).toMatch(/orgLogin/i);

    // OWNER receives only {id, name, login} — no email/sensitive fields.
    const ok = await page.request.get(
      `/api/get-user-by-id?userId=${user.id}&orgLogin=${TEST_CLASSROOM}`
    );
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(Object.keys(body).sort()).toEqual(['id', 'login', 'name']);
    expect(body.id).toBe(user.id);
    expect(body.login).toBe('prof-classmoji');
    expect(body.email).toBeUndefined();

    const unknown = await page.request.get(
      `/api/get-user-by-id?userId=does-not-exist-xyz&orgLogin=${TEST_CLASSROOM}`
    );
    expect(unknown.status()).toBe(404);

    expect(classroom.slug).toBe(TEST_CLASSROOM);
  });

  test('a non-owner (student) is denied get-user-by-id with 403 (RW-12)', async () => {
    const user = await getUserByLogin('prof-classmoji');
    const student = await requestAs('student');
    const res = await student.get(
      `/api/get-user-by-id?userId=${user.id}&orgLogin=${TEST_CLASSROOM}`
    );
    expect(res.status()).toBe(403);
    await student.dispose();
  });
});

test.describe('REGRESSION: api.gitRepoAssignment autograde authorization still works after TS migration', () => {
  // RW-07 contract = authorization + the modules->repos endpoint rename. We
  // accept either the success branch or the known downstream Trigger.dev failure,
  // but not a generic 500/pre-gate crash.
  test('owner is authorized for the renamed autograde endpoint and the old path is gone', async ({
    authenticatedPage: page,
  }) => {
    const res = await page.request.post(
      `/api/gitRepoAssignment/${TEST_CLASSROOM}?action=autograde`,
      { data: { workflowName: 'noop-regression-probe' } }
    );
    const text = await res.text();
    expect([403, 404], text).not.toContain(res.status());
    if (res.status() !== 200) {
      expect(text).toMatch(/trigger|workflow|batch|run/i);
    }

    // The pre-rename path (api.repositoryAssignment.$class) must no longer resolve -> 404.
    const oldPath = await page.request.post(
      `/api/repositoryAssignment/${TEST_CLASSROOM}?action=autograde`,
      { data: { workflowName: 'noop' } }
    );
    expect(oldPath.status()).toBe(404);
  });

  test('a student is denied the autograde endpoint with 403 (RW-07)', async () => {
    const student = await requestAs('student');
    const res = await student.post(
      `/api/gitRepoAssignment/${TEST_CLASSROOM}?action=autograde`,
      { data: { workflowName: 'noop-regression-probe' } }
    );
    expect(res.status()).toBe(403);
    await student.dispose();
  });

  test.fixme(
    true,
    'MISSING: the archived/locked-classroom mutation-gate (assertClassroomMutationAllowed -> 403 typed code) requires a classroom in LOCKED/ARCHIVED status. The shared dev seed has only the ACTIVE classmoji-dev-winter-2025; toggling its status would disturb other read-only specs.'
  );
});
