/**
 * The forms admin routes when an audit row cannot be written.
 *
 * A change that is already saved is answered as saved: the row goes through
 * the audit service's `record` (one retry, then an `audit_miss` line), so the
 * person is never told a saved change failed and a bulk edit does not stop
 * halfway. A read of other people's answers is recorded BEFORE they are handed
 * over, through `create`, and still fails when that row cannot be written.
 *
 * The REAL list and responses routes run with the database, the session gate
 * and the services swapped for fakes (`importTreeWithStubs`). The fake
 * `audit.record` is the real rule (`recordWith`) over the fake `create`, so a
 * `create` that throws behaves as production would.
 */
import { test, expect } from '@playwright/test';
import { recordWith } from '@classmoji/services/audit';

import { importTreeWithStubs, stubModule } from '../helpers/dataRequest.helpers.ts';

type Fakes = {
  auditFails: boolean;
  auditAttempts: unknown[];
  writes: string[];
};
const fakes: Fakes = { auditFails: false, auditAttempts: [], writes: [] };
const shared = globalThis as unknown as {
  __formsAuditFakes: Fakes;
  __formsAuditRecordWith: typeof recordWith;
};
shared.__formsAuditFakes = fakes;
shared.__formsAuditRecordWith = recordWith;

const FORM = {
  id: 'form-1',
  title: 'Check-in',
  slug: 'check-in',
  access: 'CLASSROOM',
  status: 'OPEN',
  save_partials: false,
  response_cap: null,
  responses_per_person: 'ONE',
  current_revision_id: null,
  draft_fields: [],
};

const DB_STUB = stubModule(`
const f = () => globalThis.__formsAuditFakes;
export const getAuthSession = async () => null;
export const GIT_IDENTITY = {};
const create = async row => {
  f().auditAttempts.push(row);
  if (f().auditFails) throw new Error('database away');
  return { id: 'row-' + f().auditAttempts.length };
};
export const prisma = {
  form: { findFirst: async () => ({ id: 'form-1', title: 'Check-in', slug: 'check-in' }) },
  formRevision: { findMany: async () => [] },
  formResponse: {
    findMany: async ({ where }) => where.id.in.map(id => ({ id })),
  },
  user: { findMany: async () => [] },
};
export const ClassmojiService = {
  audit: { create, record: row => globalThis.__formsAuditRecordWith(create, row) },
  form: {
    findBySlug: async () => (${JSON.stringify(FORM)}),
    fieldsOf: () => [],
    quickUpdate: async () => { f().writes.push('quickUpdate'); return {}; },
    deleteForm: async () => { f().writes.push('deleteForm'); },
  },
  formIdentity: {
    identityMaskForForm: async () => new Set(),
    responseNames: async () => new Map(),
  },
  formResponse: {
    listByFormId: async () => [],
    statusLabelSuggestions: async () => [],
    updateStaff: async ({ responseId }) => { f().writes.push('updateStaff:' + responseId); },
    deleteResponse: async id => { f().writes.push('deleteResponse:' + id); },
  },
};
`);

const AUTH_STUB = stubModule(`
export const assertFormAdmin = async () => ({
  classroom: { id: 'class-1', status: 'ACTIVE' },
  userId: 'staff-1',
  membership: { role: 'OWNER' },
});
export const formMutationBlocked = () => null;
`);

const STUBS = {
  '.css': stubModule(''),
  // A CommonJS file without its extension, which Node's ESM loader cannot name.
  'dayjs/plugin/relativeTime': stubModule('export default () => {};'),
  '/app/utils/db.server.ts': DB_STUB,
  '/app/utils/formAuth.server.ts': AUTH_STUB,
};

type RouteArgs = {
  params: Record<string, string | undefined>;
  request: Request;
  url: URL;
};
type Route = {
  action: (args: RouteArgs) => Promise<unknown>;
  loader?: (args: RouteArgs) => Promise<unknown>;
};

let list: Route;
let responses: Route;

test.beforeAll(async () => {
  list = await importTreeWithStubs<Route>(
    new URL('../../app/forms/admin/list.tsx', import.meta.url),
    STUBS,
    'forms-audit-list'
  );
  responses = await importTreeWithStubs<Route>(
    new URL('../../app/forms/admin/responses.tsx', import.meta.url),
    STUBS,
    'forms-audit-responses'
  );
});

test.beforeEach(() => {
  fakes.auditFails = false;
  fakes.auditAttempts = [];
  fakes.writes = [];
});

const post = (path: string, body: unknown): RouteArgs => ({
  params: { classroomSlug: 'intro', formSlug: 'check-in' },
  request: new Request(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }),
  url: new URL(`http://localhost${path}`),
});

/** Silence the audit_miss lines, and count them. */
async function withQuietMisses<T>(run: () => Promise<T>): Promise<{ value: T; misses: number }> {
  const original = console.error;
  let misses = 0;
  console.error = (...args: unknown[]) => {
    if (args[0] === 'audit_miss') misses += 1;
  };
  try {
    return { value: await run(), misses };
  } finally {
    console.error = original;
  }
}

test.describe('a saved change whose audit row cannot be written', () => {
  test('the forms list answers a status change as made', async () => {
    fakes.auditFails = true;
    const { value, misses } = await withQuietMisses(() =>
      list.action(
        post('/intro/forms', { intent: 'update-status', formId: 'form-1', status: 'CLOSED' })
      )
    );
    expect(value).toEqual({ ok: true });
    expect(fakes.writes).toEqual(['quickUpdate']);
    // Tried once more, then one audit_miss line.
    expect(fakes.auditAttempts).toHaveLength(2);
    expect(misses).toBe(1);
  });

  test('the forms list answers a delete as made', async () => {
    fakes.auditFails = true;
    const { value } = await withQuietMisses(() =>
      list.action(post('/intro/forms', { intent: 'delete', formId: 'form-1' }))
    );
    expect(value).toEqual({ ok: true });
    expect(fakes.writes).toEqual(['deleteForm']);
  });

  test('a bulk triage edit finishes every response', async () => {
    fakes.auditFails = true;
    const { value, misses } = await withQuietMisses(() =>
      responses.action(
        post('/intro/forms/check-in/responses', {
          intent: 'set-status',
          status: 'Reviewed',
          responseIds: ['r-1', 'r-2', 'r-3'],
        })
      )
    );
    expect(value).toEqual({ ok: true, updated: 3 });
    expect(fakes.writes).toEqual(['updateStaff:r-1', 'updateStaff:r-2', 'updateStaff:r-3']);
    expect(misses).toBe(3);
  });

  test('a bulk delete finishes every response', async () => {
    fakes.auditFails = true;
    const { value } = await withQuietMisses(() =>
      responses.action(
        post('/intro/forms/check-in/responses', { intent: 'delete', responseIds: ['r-1', 'r-2'] })
      )
    );
    expect(value).toEqual({ ok: true, deleted: 2 });
    expect(fakes.writes).toEqual(['deleteResponse:r-1', 'deleteResponse:r-2']);
  });

  test('with the row written, it is written once per change', async () => {
    const value = await responses.action(
      post('/intro/forms/check-in/responses', {
        intent: 'set-status',
        status: 'Reviewed',
        responseIds: ['r-1', 'r-2'],
      })
    );
    expect(value).toEqual({ ok: true, updated: 2 });
    expect(fakes.auditAttempts).toHaveLength(2);
  });
});

test.describe('a read recorded before its data is handed over', () => {
  test('the responses list fails when its VIEW row cannot be written', async () => {
    fakes.auditFails = true;
    const path = '/intro/forms/check-in/responses';
    await expect(
      responses.loader!({
        params: { classroomSlug: 'intro', formSlug: 'check-in' },
        request: new Request(`http://localhost${path}`),
        url: new URL(`http://localhost${path}`),
      })
    ).rejects.toThrow('database away');
    // Written once, through create: no retry, nothing handed over.
    expect(fakes.auditAttempts).toHaveLength(1);
  });

  test('the responses list loads when its VIEW row is written', async () => {
    const path = '/intro/forms/check-in/responses';
    await expect(
      responses.loader!({
        params: { classroomSlug: 'intro', formSlug: 'check-in' },
        request: new Request(`http://localhost${path}`),
        url: new URL(`http://localhost${path}`),
      })
    ).resolves.toBeTruthy();
    expect(fakes.auditAttempts).toHaveLength(1);
  });
});
