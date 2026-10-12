/**
 * Page sections on the server: who receives which locked bodies, and the
 * `/api/page-sections` gates.
 *
 * Three layers, each held where it can be:
 *  - the rules (`~/utils/pageSections.server.ts`) — pure, called directly;
 *  - the API handlers — driven end to end with fake lookups, so every status
 *    path (401/403/404/400/409/413) runs without Postgres or a content repo;
 *  - the page loader and the class site — they need Postgres to run, so where
 *    the redaction sits in them is pinned from source (the
 *    `media-editor-gates.spec.ts` approach), and the site's static render is
 *    rendered for real.
 *
 * The leak this exists to stop is quiet: a locked body that reached a
 * student's payload, an asset map or the site's HTML looks exactly like a
 * working feature until someone opens view-source.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations (see site-render.spec.ts).
import { JSDOM as UntypedJSDOM } from 'jsdom';
import { collectBlockAssetRefs } from '@classmoji/utils';

import {
  NO_READER_ACCESS,
  SECTION_NO_STORE_HEADERS,
  documentForReader,
  documentForSite,
  handleSectionsGet,
  handleSectionsPost,
  isImpersonatedSession,
  parseSectionRequest,
  readerSectionsFor,
  revealsAllSections,
  sectionTargetValid,
  type PageSectionsDeps,
  type SectionReaderAccess,
  type SectionsPage,
} from '~/utils/pageSections.server.ts';
import { collectMediaDownloadRefs } from '~/utils/mediaDownloads.ts';
import { renderSitePage } from '~/site/render.server.ts';

const JSDOM = UntypedJSDOM as new (html?: string) => { window: { document: Document } };
const parse = (html: string): Document => new JSDOM(`<body>${html}</body>`).window.document;

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

// ── Fixture document ───────────────────────────────────────────────────────
//
// A checkable heading at the top level; two columns; the left column holds a
// locked section ("outer") whose body has an image, a media file, a checkable
// heading and a NESTED locked section ("inner") with its own image; the right
// column holds a second locked section ("solo").

const MEDIA_ID = '11111111-2222-4333-8444-555555555555';

function fixture() {
  return [
    {
      id: 'h-top',
      type: 'heading',
      props: { level: 2, checkable: true },
      content: text('Part 1'),
      children: [],
    },
    { id: 'h-plain', type: 'heading', props: { level: 2 }, content: text('Plain'), children: [] },
    {
      id: 'cols',
      type: 'columnList',
      props: {},
      children: [
        {
          id: 'col-a',
          type: 'column',
          props: { width: 1 },
          children: [
            {
              id: 'outer',
              type: 'lockedSection',
              props: {},
              content: text('Outer title'),
              children: [
                {
                  id: 'p-outer',
                  type: 'paragraph',
                  content: text('OUTER-SECRET-BODY'),
                  children: [],
                },
                {
                  id: 'img-outer',
                  type: 'image',
                  props: { url: 'pages/demo/assets/outer-secret.png', caption: 'outer img' },
                  children: [],
                },
                {
                  id: 'file-outer',
                  type: 'file',
                  props: { url: `media://${MEDIA_ID}`, name: 'answers.pdf' },
                  children: [],
                },
                {
                  id: 'h-in-outer',
                  type: 'heading',
                  props: { level: 3, checkable: true },
                  content: text('Hidden step'),
                  children: [],
                },
                {
                  id: 'inner',
                  type: 'lockedSection',
                  props: {},
                  content: text('Inner title'),
                  children: [
                    {
                      id: 'p-inner',
                      type: 'paragraph',
                      content: text('INNER-SECRET-BODY'),
                      children: [],
                    },
                    {
                      id: 'img-inner',
                      type: 'image',
                      props: { url: 'pages/demo/assets/inner-secret.png' },
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'col-b',
          type: 'column',
          props: { width: 1 },
          children: [
            {
              id: 'solo',
              type: 'lockedSection',
              props: {},
              content: text('Solo title'),
              children: [
                {
                  id: 'p-solo',
                  type: 'paragraph',
                  content: text('SOLO-SECRET-BODY'),
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'img-public',
      type: 'image',
      props: { url: 'pages/demo/assets/public.png' },
      children: [],
    },
  ];
}

const SECRETS = ['OUTER-SECRET-BODY', 'INNER-SECRET-BODY', 'SOLO-SECRET-BODY'];
const SECRET_REFS = ['outer-secret.png', 'inner-secret.png', MEDIA_ID];

// ── Rules ──────────────────────────────────────────────────────────────────

test.describe('who sees locked bodies', () => {
  const student: SectionReaderAccess = {
    acceptedRole: 'STUDENT',
    teachingTeam: false,
    student: true,
  };
  const ta: SectionReaderAccess = { acceptedRole: 'ASSISTANT', teachingTeam: true, student: false };

  test('editors and the accepted teaching team reveal all; a student does not', () => {
    expect(revealsAllSections({ canEdit: true, access: NO_READER_ACCESS })).toBe(true);
    expect(revealsAllSections({ canEdit: false, access: ta })).toBe(true);
    expect(revealsAllSections({ canEdit: false, access: student })).toBe(false);
    expect(revealsAllSections({ canEdit: false, access: NO_READER_ACCESS })).toBe(false);
  });

  test('a reveal-all reader gets the document untouched (same object)', () => {
    const doc = fixture();
    expect(documentForReader(doc, { revealAll: true, unlocked: {} })).toBe(doc);
  });

  test('a reader who unlocked nothing gets no body, at any depth, and no asset refs from them', () => {
    const doc = fixture();
    const before = JSON.stringify(doc);
    const out = documentForReader(doc, { revealAll: false, unlocked: {} });
    const serialized = JSON.stringify(out);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Hidden step');
    // Titles stay (the closed card shows them).
    expect(serialized).toContain('Outer title');
    expect(serialized).toContain('Solo title');
    // Nothing derived from the document can name a body's files.
    const refs = collectBlockAssetRefs(out).join(' ');
    for (const ref of SECRET_REFS) expect(refs).not.toContain(ref);
    expect(refs).toContain('public.png');
    expect(collectMediaDownloadRefs(out)).toEqual([]);
    // Input untouched (a shared content cache).
    expect(JSON.stringify(doc)).toBe(before);
  });

  test('unlocking the outer section reveals it but not the nested one', () => {
    const out = documentForReader(fixture(), {
      revealAll: false,
      unlocked: { outer: '2026-10-12T00:00:00.000Z' },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).toContain('OUTER-SECRET-BODY');
    expect(serialized).not.toContain('INNER-SECRET-BODY');
    expect(serialized).not.toContain('SOLO-SECRET-BODY');
    const refs = collectBlockAssetRefs(out).join(' ');
    expect(refs).toContain('outer-secret.png');
    expect(refs).not.toContain('inner-secret.png');
  });

  test('an unlock of the nested section alone opens nothing while its parent is locked', () => {
    const serialized = JSON.stringify(
      documentForReader(fixture(), { revealAll: false, unlocked: { inner: 'x' } })
    );
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
  });

  test('`unlocked` is read as own keys only (no prototype reveal)', () => {
    const doc = [
      {
        id: 'constructor',
        type: 'lockedSection',
        props: {},
        content: [],
        children: [{ id: 'x', type: 'paragraph', content: text('PROTO-SECRET') }],
      },
    ];
    const serialized = JSON.stringify(documentForReader(doc, { revealAll: false, unlocked: {} }));
    expect(serialized).not.toContain('PROTO-SECRET');
  });
});

test.describe('readerSections (the loader contract)', () => {
  const state = { checked: ['h-top'], unlocked: { solo: '2026-10-12T10:00:00.000Z' } };

  test('anonymous: all false and empty', () => {
    expect(
      readerSectionsFor({
        signedIn: false,
        access: NO_READER_ACCESS,
        impersonated: false,
        revealAll: false,
        state: null,
      })
    ).toEqual({ staff: false, canCheck: false, canUnlock: false, checked: [], unlocked: {} });
  });

  test('accepted student: can check and unlock, sees own state', () => {
    expect(
      readerSectionsFor({
        signedIn: true,
        access: { acceptedRole: 'STUDENT', teachingTeam: false, student: true },
        impersonated: false,
        revealAll: false,
        state,
      })
    ).toEqual({ staff: false, canCheck: true, canUnlock: true, ...state });
  });

  test('impersonated student: sees the state, can do nothing', () => {
    const out = readerSectionsFor({
      signedIn: true,
      access: { acceptedRole: 'STUDENT', teachingTeam: false, student: true },
      impersonated: true,
      revealAll: false,
      state,
    });
    expect(out.canCheck).toBe(false);
    expect(out.canUnlock).toBe(false);
  });

  test('teaching team: staff, may check, never unlock', () => {
    const out = readerSectionsFor({
      signedIn: true,
      access: { acceptedRole: 'ASSISTANT', teachingTeam: true, student: false },
      impersonated: false,
      revealAll: true,
      state: { checked: [], unlocked: {} },
    });
    expect(out).toMatchObject({ staff: true, canCheck: true, canUnlock: false });
  });

  test('student who also edits (canEdit via a pending staff invite): staff, no unlock', () => {
    const out = readerSectionsFor({
      signedIn: true,
      access: { acceptedRole: 'STUDENT', teachingTeam: false, student: true },
      impersonated: false,
      revealAll: true,
      state: { checked: [], unlocked: {} },
    });
    expect(out).toMatchObject({ staff: true, canCheck: true, canUnlock: false });
  });

  test('signed in without an accepted membership: no state even if handed one', () => {
    const out = readerSectionsFor({
      signedIn: true,
      access: NO_READER_ACCESS,
      impersonated: false,
      revealAll: false,
      state,
    });
    expect(out).toEqual({
      staff: false,
      canCheck: false,
      canUnlock: false,
      checked: [],
      unlocked: {},
    });
  });

  test('impersonation is read off better-auth and the dev fallback alike', () => {
    expect(isImpersonatedSession({ session: { session: { impersonatedBy: 'admin-id' } } })).toBe(
      true
    );
    expect(isImpersonatedSession({ session: { session: { impersonatedBy: null } } })).toBe(false);
    expect(isImpersonatedSession({ session: { session: {} } })).toBe(false);
    expect(isImpersonatedSession(null)).toBe(false);
  });
});

test.describe('request parsing and targets', () => {
  test('parseSectionRequest accepts exactly the contract', () => {
    expect(parseSectionRequest({ pageId: 'p', blockId: 'b-1', intent: 'unlock' })).toEqual({
      pageId: 'p',
      blockId: 'b-1',
      intent: 'unlock',
    });
    for (const bad of [
      null,
      [],
      'x',
      { pageId: 'p', blockId: 'b', intent: 'delete' },
      { pageId: '', blockId: 'b', intent: 'check' },
      { pageId: 'p', blockId: { $ne: '' }, intent: 'check' },
      { pageId: 'p', blockId: 'a'.repeat(65), intent: 'check' },
      { pageId: 'p', blockId: 'has space', intent: 'check' },
      { pageId: { in: ['a'] }, blockId: 'b', intent: 'check' },
    ]) {
      expect(parseSectionRequest(bad)).toBeNull();
    }
  });

  test('targets are checked by type in the given tree', () => {
    const doc = fixture();
    expect(sectionTargetValid(doc, 'h-top', 'check')).toBe(true);
    expect(sectionTargetValid(doc, 'h-plain', 'check')).toBe(false);
    expect(sectionTargetValid(doc, 'outer', 'check')).toBe(false);
    expect(sectionTargetValid(doc, 'outer', 'unlock')).toBe(true);
    expect(sectionTargetValid(doc, 'h-top', 'unlock')).toBe(false);
    expect(sectionTargetValid(doc, 'nope', 'unlock')).toBe(false);
  });
});

// ── API handlers ───────────────────────────────────────────────────────────

type Page = SectionsPage & { title: string };

const ORIGIN = 'http://pages.test';
const CLASS_A = 'class-a';
const CLASS_B = 'class-b';

/** Users and their accepted roles, per classroom. */
const MEMBERS: Record<string, Record<string, string>> = {
  'student-1': { [CLASS_A]: 'STUDENT' },
  'student-2': { [CLASS_A]: 'STUDENT' },
  'ta-1': { [CLASS_A]: 'ASSISTANT' },
  'teacher-1': { [CLASS_A]: 'TEACHER' },
  'owner-1': { [CLASS_A]: 'OWNER' },
  'owner-b': { [CLASS_B]: 'OWNER' },
  'student-b': { [CLASS_B]: 'STUDENT' },
  'pending-1': {},
};

const PAGES: Record<string, Page> = {
  'page-a': { id: 'page-a', classroom_id: CLASS_A, is_draft: false, title: 'A' },
  'draft-a': { id: 'draft-a', classroom_id: CLASS_A, is_draft: true, title: 'Draft' },
  'page-b': { id: 'page-b', classroom_id: CLASS_B, is_draft: false, title: 'B' },
};

function makeDeps(overrides: Partial<PageSectionsDeps<Page>> = {}) {
  const calls = {
    setChecked: [] as unknown[],
    recordUnlock: [] as unknown[],
    sectionActivity: [] as unknown[],
    audit: [] as unknown[],
    loadReaderBlocks: 0,
  };
  const unlocks: Record<string, Record<string, string>> = {}; // userId -> blockId -> iso
  const checkedKeys = new Set<string>(); // `${pageId}|${userId}|${blockId}`
  const deps: PageSectionsDeps<Page> = {
    async getSession(request) {
      const user = request.headers.get('x-user');
      if (!user) return null;
      return { userId: user, impersonated: request.headers.get('x-impersonated') === '1' };
    },
    async findPage(id) {
      return PAGES[id] ?? null;
    },
    async readerAccess({ userId, classroomId }) {
      const role = MEMBERS[userId]?.[classroomId] ?? null;
      return {
        acceptedRole: role,
        teachingTeam: role !== null && role !== 'STUDENT',
        student: role === 'STUDENT',
      };
    },
    async canEdit({ userId, classroomId }) {
      const role = MEMBERS[userId]?.[classroomId];
      return role === 'OWNER' || role === 'TEACHER';
    },
    async readerState({ userId }) {
      return { checked: [], unlocked: { ...(unlocks[userId] ?? {}) } };
    },
    async loadReaderBlocks() {
      calls.loadReaderBlocks++;
      return fixture();
    },
    async setChecked(args) {
      calls.setChecked.push(args);
      // Like the service: `changed` only when the row was made or removed.
      const key = `${args.pageId}|${args.userId}|${args.blockId}`;
      const changed = args.checked ? !checkedKeys.has(key) : checkedKeys.has(key);
      if (args.checked) checkedKeys.add(key);
      else checkedKeys.delete(key);
      return { checked: args.checked, changed };
    },
    async recordUnlock(args) {
      calls.recordUnlock.push(args);
      const at = new Date('2026-10-12T15:00:00.000Z');
      const created = !unlocks[args.userId]?.[args.blockId];
      unlocks[args.userId] = { ...(unlocks[args.userId] ?? {}), [args.blockId]: at.toISOString() };
      return { unlockedAt: at, created };
    },
    async sectionActivity(args) {
      calls.sectionActivity.push(args);
      if (args.classroomId !== PAGES[args.pageId]?.classroom_id) return null;
      return {
        students: 2,
        unlocks: [
          {
            userId: 'student-1',
            name: 'Student One',
            login: 'fake-student-1',
            avatarUrl: null,
            at: new Date('2026-10-12T15:00:00.000Z'),
          },
        ],
      };
    },
    async audit(args) {
      calls.audit.push(args);
    },
    isValidationError: error =>
      error instanceof Error && error.name === 'PageSectionsValidationError',
    ...overrides,
  };
  return { deps, calls, unlocks };
}

function post(
  body: unknown,
  {
    user,
    impersonated,
    origin = ORIGIN,
  }: { user?: string; impersonated?: boolean; origin?: string } = {}
) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin };
  if (user) headers['x-user'] = user;
  if (impersonated) headers['x-impersonated'] = '1';
  return new Request(`${ORIGIN}/api/page-sections`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(query: string, user?: string) {
  return new Request(`${ORIGIN}/api/page-sections?${query}`, {
    headers: user ? { 'x-user': user } : {},
  });
}

async function call(response: Promise<Response>) {
  const res = await response;
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

test.describe('POST /api/page-sections', () => {
  test('every answer is private, no-store, varied on Cookie', async () => {
    const { deps } = makeDeps();
    for (const req of [
      post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
      post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }),
      post({ pageId: 'nope', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
    ]) {
      const res = await handleSectionsPost(req, deps);
      for (const [key, value] of Object.entries(SECTION_NO_STORE_HEADERS)) {
        expect(res.headers.get(key)).toBe(value);
      }
    }
  });

  test('method, origin, size and shape are refused before anything is read', async () => {
    const { deps, calls } = makeDeps();
    const wrongMethod = new Request(`${ORIGIN}/api/page-sections`, { method: 'PUT', body: '{}' });
    expect((await handleSectionsPost(wrongMethod, deps)).status).toBe(405);
    expect(
      (
        await handleSectionsPost(
          post(
            { pageId: 'page-a', blockId: 'h-top', intent: 'check' },
            {
              user: 'student-1',
              origin: 'https://evil.example',
            }
          ),
          deps
        )
      ).status
    ).toBe(403);
    expect(
      (await handleSectionsPost(post('x'.repeat(5000), { user: 'student-1' }), deps)).status
    ).toBe(413);
    expect((await handleSectionsPost(post('{nope', { user: 'student-1' }), deps)).status).toBe(400);
    expect(
      (
        await handleSectionsPost(
          post({ pageId: 'page-a', blockId: 'h-top', intent: 'delete' }, { user: 'student-1' }),
          deps
        )
      ).status
    ).toBe(400);
    expect(calls.loadReaderBlocks).toBe(0);
  });

  test('anonymous → 401', async () => {
    const { deps } = makeDeps();
    const res = await call(
      handleSectionsPost(post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }), deps)
    );
    expect(res.status).toBe(401);
  });

  test('unknown page, another classroom’s page, and a pending invite all look the same: 404', async () => {
    const { deps, calls } = makeDeps();
    const unknown = await call(
      handleSectionsPost(
        post({ pageId: 'nope', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
        deps
      )
    );
    const crossClass = await call(
      handleSectionsPost(
        post({ pageId: 'page-b', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
        deps
      )
    );
    const pending = await call(
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'pending-1' }),
        deps
      )
    );
    expect([unknown.status, crossClass.status, pending.status]).toEqual([404, 404, 404]);
    expect(crossClass.body).toEqual(unknown.body);
    expect(pending.body).toEqual(unknown.body);
    expect(calls.loadReaderBlocks).toBe(0);
    expect(calls.setChecked).toEqual([]);
  });

  test('a draft is 404 for a student, open to the teaching team', async () => {
    const { deps } = makeDeps();
    expect(
      (
        await call(
          handleSectionsPost(
            post({ pageId: 'draft-a', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
            deps
          )
        )
      ).status
    ).toBe(404);
    expect(
      (
        await call(
          handleSectionsPost(
            post({ pageId: 'draft-a', blockId: 'h-top', intent: 'check' }, { user: 'ta-1' }),
            deps
          )
        )
      ).status
    ).toBe(200);
  });

  test('impersonated sessions write nothing: 403', async () => {
    const { deps, calls } = makeDeps();
    for (const intent of ['check', 'uncheck', 'unlock']) {
      const blockId = intent === 'unlock' ? 'outer' : 'h-top';
      const res = await call(
        handleSectionsPost(
          post({ pageId: 'page-a', blockId, intent }, { user: 'student-1', impersonated: true }),
          deps
        )
      );
      expect(res.status).toBe(403);
    }
    expect(calls.setChecked).toEqual([]);
    expect(calls.recordUnlock).toEqual([]);
  });

  test('check and uncheck write this user’s row only', async () => {
    const { deps, calls } = makeDeps();
    const checked = await call(
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
        deps
      )
    );
    expect(checked).toMatchObject({ status: 200, body: { ok: true, checked: true } });
    const unchecked = await call(
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'h-top', intent: 'uncheck' }, { user: 'student-2' }),
        deps
      )
    );
    expect(unchecked).toMatchObject({ status: 200, body: { ok: true, checked: false } });
    expect(calls.setChecked).toEqual([
      { pageId: 'page-a', userId: 'student-1', blockId: 'h-top', checked: true },
      { pageId: 'page-a', userId: 'student-2', blockId: 'h-top', checked: false },
    ]);
  });

  test('forged and wrong-type block ids are 400', async () => {
    const { deps, calls } = makeDeps();
    for (const [blockId, intent] of [
      ['forged-id', 'check'],
      ['forged-id', 'unlock'],
      ['h-plain', 'check'], // a heading, not checkable
      ['outer', 'check'], // a locked section is not a heading
      ['h-top', 'unlock'], // a heading is not a locked section
    ] as const) {
      const res = await call(
        handleSectionsPost(post({ pageId: 'page-a', blockId, intent }, { user: 'student-1' }), deps)
      );
      expect(res.status, `${intent} ${blockId}`).toBe(400);
    }
    expect(calls.setChecked).toEqual([]);
    expect(calls.recordUnlock).toEqual([]);
  });

  test('blocks inside a body this student has not unlocked do not exist for them', async () => {
    const { deps, calls } = makeDeps();
    // The nested lock and the heading inside the outer body: 400 while outer is locked.
    expect(
      (
        await call(
          handleSectionsPost(
            post({ pageId: 'page-a', blockId: 'inner', intent: 'unlock' }, { user: 'student-1' }),
            deps
          )
        )
      ).status
    ).toBe(400);
    expect(
      (
        await call(
          handleSectionsPost(
            post(
              { pageId: 'page-a', blockId: 'h-in-outer', intent: 'check' },
              { user: 'student-1' }
            ),
            deps
          )
        )
      ).status
    ).toBe(400);
    expect(calls.recordUnlock).toEqual([]);

    // Unlock outer → both become reachable for THIS student.
    const unlocked = await call(
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'outer', intent: 'unlock' }, { user: 'student-1' }),
        deps
      )
    );
    expect(unlocked.status).toBe(200);
    expect(
      (
        await call(
          handleSectionsPost(
            post({ pageId: 'page-a', blockId: 'inner', intent: 'unlock' }, { user: 'student-1' }),
            deps
          )
        )
      ).status
    ).toBe(200);
    expect(
      (
        await call(
          handleSectionsPost(
            post(
              { pageId: 'page-a', blockId: 'h-in-outer', intent: 'check' },
              { user: 'student-1' }
            ),
            deps
          )
        )
      ).status
    ).toBe(200);

    // ...and still not for another student.
    expect(
      (
        await call(
          handleSectionsPost(
            post({ pageId: 'page-a', blockId: 'inner', intent: 'unlock' }, { user: 'student-2' }),
            deps
          )
        )
      ).status
    ).toBe(400);
  });

  test('the teaching team validates against the whole document', async () => {
    const { deps } = makeDeps();
    expect(
      (
        await call(
          handleSectionsPost(
            post({ pageId: 'page-a', blockId: 'h-in-outer', intent: 'check' }, { user: 'ta-1' }),
            deps
          )
        )
      ).status
    ).toBe(200);
  });

  test('unlock answers with the time and nothing else', async () => {
    const { deps, calls } = makeDeps();
    const res = await call(
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'solo', intent: 'unlock' }, { user: 'student-1' }),
        deps
      )
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, unlockedAt: '2026-10-12T15:00:00.000Z' });
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    // The classroom recorded is the page's own.
    expect(calls.recordUnlock).toEqual([
      { page: { id: 'page-a', classroom_id: CLASS_A }, userId: 'student-1', blockId: 'solo' },
    ]);
  });

  test('staff cannot unlock: 409, nothing recorded', async () => {
    const { deps, calls } = makeDeps();
    for (const user of ['ta-1', 'teacher-1', 'owner-1']) {
      const res = await call(
        handleSectionsPost(
          post({ pageId: 'page-a', blockId: 'solo', intent: 'unlock' }, { user }),
          deps
        )
      );
      expect(res.status, user).toBe(409);
    }
    // An accepted student whose pending staff invite makes them an editor.
    const { deps: editorDeps, calls: editorCalls } = makeDeps({ canEdit: async () => true });
    expect(
      (
        await call(
          handleSectionsPost(
            post({ pageId: 'page-a', blockId: 'solo', intent: 'unlock' }, { user: 'student-1' }),
            editorDeps
          )
        )
      ).status
    ).toBe(409);
    expect(calls.recordUnlock).toEqual([]);
    expect(editorCalls.recordUnlock).toEqual([]);
  });

  test('a service validation error is a 400, anything else propagates', async () => {
    const validation = Object.assign(new Error('Invalid block id'), {
      name: 'PageSectionsValidationError',
    });
    const { deps } = makeDeps({
      setChecked: async () => {
        throw validation;
      },
    });
    expect(
      (
        await call(
          handleSectionsPost(
            post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
            deps
          )
        )
      ).status
    ).toBe(400);

    const { deps: broken } = makeDeps({
      setChecked: async () => {
        throw new Error('db down');
      },
    });
    await expect(
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
        broken
      )
    ).rejects.toThrow('db down');
  });

  test('audit: a first unlock is a CREATE, a repeat logs nothing', async () => {
    const { deps, calls } = makeDeps();
    const body = { pageId: 'page-a', blockId: 'solo', intent: 'unlock' };
    await handleSectionsPost(post(body, { user: 'student-1' }), deps);
    await handleSectionsPost(post(body, { user: 'student-1' }), deps);
    expect(calls.audit).toEqual([
      {
        userId: 'student-1',
        classroomId: CLASS_A,
        role: 'STUDENT',
        pageId: 'page-a',
        action: 'CREATE',
        data: { tool: 'page_section_unlock', block_id: 'solo' },
      },
    ]);
  });

  test('audit: check is a CREATE, uncheck a DELETE, both with the new state', async () => {
    const { deps, calls } = makeDeps();
    await handleSectionsPost(
      post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
      deps
    );
    await handleSectionsPost(
      post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'ta-1' }),
      deps
    );
    await handleSectionsPost(
      post({ pageId: 'page-a', blockId: 'h-top', intent: 'uncheck' }, { user: 'ta-1' }),
      deps
    );
    expect(calls.audit).toEqual([
      {
        userId: 'student-1',
        classroomId: CLASS_A,
        role: 'STUDENT',
        pageId: 'page-a',
        action: 'CREATE',
        data: { tool: 'page_section_check', block_id: 'h-top', checked: true },
      },
      {
        userId: 'ta-1',
        classroomId: CLASS_A,
        role: 'ASSISTANT',
        pageId: 'page-a',
        action: 'CREATE',
        data: { tool: 'page_section_check', block_id: 'h-top', checked: true },
      },
      {
        userId: 'ta-1',
        classroomId: CLASS_A,
        role: 'ASSISTANT',
        pageId: 'page-a',
        action: 'DELETE',
        data: { tool: 'page_section_check', block_id: 'h-top', checked: false },
      },
    ]);
  });

  test('audit: a repeat check or a repeat uncheck writes no audit row', async () => {
    const { deps, calls } = makeDeps();
    const send = (intent: string) =>
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'h-top', intent }, { user: 'student-1' }),
        deps
      );

    // Unchecking something never checked: no change, no row.
    expect((await call(send('uncheck'))).status).toBe(200);
    expect(calls.audit).toEqual([]);

    await send('check');
    await send('check'); // repeat
    expect(calls.audit).toHaveLength(1);
    expect(calls.audit[0]).toMatchObject({ action: 'CREATE' });

    await send('uncheck');
    await send('uncheck'); // repeat
    expect(calls.audit).toHaveLength(2);
    expect(calls.audit[1]).toMatchObject({ action: 'DELETE' });

    // Every request still reached the service and answered with the state.
    expect(calls.setChecked).toHaveLength(5);
  });

  test('audit: refused requests log nothing; a failed audit does not fail the write', async () => {
    const { deps, calls } = makeDeps();
    for (const [blockId, intent, user] of [
      ['forged', 'check', 'student-1'],
      ['solo', 'unlock', 'ta-1'],
      ['solo', 'unlock', 'pending-1'],
    ]) {
      await handleSectionsPost(post({ pageId: 'page-a', blockId, intent }, { user }), deps);
    }
    await handleSectionsPost(
      post(
        { pageId: 'page-a', blockId: 'h-top', intent: 'check' },
        { user: 'student-1', impersonated: true }
      ),
      deps
    );
    expect(calls.audit).toEqual([]);

    const { deps: noAudit, calls: noAuditCalls } = makeDeps({
      audit: async () => {
        throw new Error('audit down');
      },
    });
    const res = await call(
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'solo', intent: 'unlock' }, { user: 'student-1' }),
        noAudit
      )
    );
    expect(res.status).toBe(200);
    expect(noAuditCalls.recordUnlock).toHaveLength(1);
  });
});

test.describe('GET /api/page-sections', () => {
  test('owner and teacher of the page’s classroom get the list, ISO times, audited', async () => {
    for (const user of ['owner-1', 'teacher-1']) {
      const { deps, calls } = makeDeps();
      const res = await call(handleSectionsGet(get('pageId=page-a&blockId=solo', user), deps));
      expect(res.status, user).toBe(200);
      expect(res.body).toEqual({
        students: 2,
        unlocks: [
          {
            userId: 'student-1',
            name: 'Student One',
            login: 'fake-student-1',
            avatarUrl: null,
            unlockedAt: '2026-10-12T15:00:00.000Z',
          },
        ],
      });
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(calls.sectionActivity).toEqual([
        { pageId: 'page-a', classroomId: CLASS_A, blockId: 'solo' },
      ]);
      expect(calls.audit).toHaveLength(1);
      expect(calls.audit[0]).toEqual({
        userId: user,
        classroomId: CLASS_A,
        role: user === 'owner-1' ? 'OWNER' : 'TEACHER',
        pageId: 'page-a',
        action: 'VIEW',
        data: { tool: 'page_section_unlocks', page_id: 'page-a', block_id: 'solo' },
      });
    }
  });

  test('student, assistant, pending invite, other classroom’s owner, unknown page: identical 404', async () => {
    const { deps, calls } = makeDeps();
    const answers = [];
    for (const [query, user] of [
      ['pageId=page-a&blockId=solo', 'student-1'],
      ['pageId=page-a&blockId=solo', 'ta-1'],
      ['pageId=page-a&blockId=solo', 'pending-1'],
      ['pageId=page-a&blockId=solo', 'owner-b'], // staff of ANOTHER classroom
      ['pageId=nope&blockId=solo', 'owner-1'],
      ['blockId=solo', 'owner-1'],
    ] as const) {
      answers.push(await call(handleSectionsGet(get(query, user), deps)));
    }
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.body).toEqual(answers[0]!.body);
    }
    expect(calls.sectionActivity).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  test('a page from class B asked by class A’s owner never reaches the activity query', async () => {
    const { deps, calls } = makeDeps();
    const res = await call(handleSectionsGet(get('pageId=page-b&blockId=solo', 'owner-1'), deps));
    expect(res.status).toBe(404);
    expect(calls.sectionActivity).toEqual([]);
  });

  test('anonymous → 401; a malformed block id from staff → 400', async () => {
    const { deps } = makeDeps();
    expect((await call(handleSectionsGet(get('pageId=page-a&blockId=solo'), deps))).status).toBe(
      401
    );
    expect(
      (await call(handleSectionsGet(get('pageId=page-a&blockId=bad%20id', 'owner-1'), deps))).status
    ).toBe(400);
  });

  test('a failed audit does not fail the list', async () => {
    const { deps } = makeDeps({
      audit: async () => {
        throw new Error('audit down');
      },
    });
    expect(
      (await call(handleSectionsGet(get('pageId=page-a&blockId=solo', 'teacher-1'), deps))).status
    ).toBe(200);
  });
});

// ── Loader and site: where the redaction sits ──────────────────────────────

test.describe('the page loader', () => {
  const LOADER = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
  const loaderBody = LOADER.slice(
    LOADER.indexOf('export const loader'),
    LOADER.indexOf('export const action')
  );

  test('redacts before anything is derived from the document', () => {
    const redact = loaderBody.indexOf('viewerContent = documentForReader(viewerContent');
    expect(redact).toBeGreaterThan(0);
    // After the content is final (the HTML migration and the empty fallback)…
    expect(redact).toBeGreaterThan(
      loaderBody.indexOf("viewerContent = [{ type: 'paragraph', content: [] }];")
    );
    // …and before every consumer of it.
    for (const consumer of [
      'await resolveDocumentAssets(',
      'await loadMediaDownloads(page.classroom.id, viewerContent',
      'previewBlockChanges(',
      '    content: viewerContent,',
    ]) {
      const at = loaderBody.indexOf(consumer);
      expect(at, consumer).toBeGreaterThan(redact);
    }
    // Reveal-all is the editor's rule OR the accepted teaching team.
    expect(loaderBody).toContain('revealsAllSections({ canEdit, access: sectionAccess })');
  });

  test('reads only this reader’s state, and stats only for editors', () => {
    expect(loaderBody.match(/pageSections\.readerAccess\(/g)).toHaveLength(1);
    expect(loaderBody).toContain('pageId: page.id,\n          userId: authData.userId,');
    expect(loaderBody).toMatch(/const sectionStats = canEdit\s*\?/);
  });

  test('the raw source link is only for reveal-all readers', () => {
    expect(loaderBody).toMatch(/source_url:\s*revealAll && repoName/);
  });

  test('every response is private and uncached', () => {
    expect(LOADER).toMatch(/export const headers = /);
    expect(LOADER).toContain('SECTION_NO_STORE_HEADERS');
  });
});

test.describe('the class site', () => {
  const RENDER = source('../../app/site/pageRender.server.ts');
  const body = RENDER.slice(RENDER.indexOf('export async function renderPageForViewer'));

  test('redacts every locked body right after loading, before assets, downloads and render', () => {
    const REDACT = 'const blocks = documentForSite(content.blocks);';
    const redact = body.indexOf(REDACT);
    expect(redact).toBeGreaterThan(body.indexOf('await loadSitePageContent('));
    expect(body.indexOf('await resolveSiteAssets(assetCtx, blocks)')).toBeGreaterThan(redact);
    expect(
      body.indexOf('await loadMediaDownloads(context.site.classroom_id, blocks, role)')
    ).toBeGreaterThan(redact);
    // Nothing downstream reads the unredacted blocks again.
    const after = body.slice(redact + REDACT.length, body.indexOf('\n}\n'));
    expect(after).not.toContain('content.blocks');
  });

  test('the staff _render/page view does not go through the site path', () => {
    const view = source('../../app/utils/pageView.server.ts');
    expect(view).not.toContain('renderPageForViewer');
    expect(view).not.toContain('documentForSite');
  });

  test('documentForSite closes every locked section and is non-mutating', () => {
    const doc = fixture();
    const before = JSON.stringify(doc);
    const out = documentForSite(doc);
    const serialized = JSON.stringify(out);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(JSON.stringify(doc)).toBe(before);
    const refs = collectBlockAssetRefs(out).join(' ');
    for (const ref of SECRET_REFS) expect(refs).not.toContain(ref);
    expect(collectMediaDownloadRefs(out)).toEqual([]);
    // No locked section → same document back.
    const plain = [{ id: 'p', type: 'paragraph', content: text('hi') }];
    expect(documentForSite(plain)).toBe(plain);
  });

  test('renders closed cards with the unlock link and no body text', async () => {
    const href = 'https://pages.example/cs52/page-a';
    const { html } = await renderSitePage({
      blocks: documentForSite(fixture()),
      resolveLink: () => null,
      lockedSectionHref: href,
    });
    for (const secret of [
      ...SECRETS,
      'Hidden step',
      'outer-secret.png',
      'inner-secret.png',
      MEDIA_ID,
    ]) {
      expect(html).not.toContain(secret);
    }
    const doc = parse(html);
    const cards = [...doc.querySelectorAll('.bn-site-locked')];
    expect(cards.map(card => card.querySelector('.bn-site-locked-title')?.textContent)).toEqual([
      'Outer title',
      'Solo title',
    ]);
    for (const card of cards) {
      const link = card.querySelector('a.bn-site-locked-link');
      expect(link?.getAttribute('href')).toBe(href);
      expect(link?.textContent).toBe('Open in Classmoji to unlock');
      expect(card.querySelector('svg.bn-site-locked-icon')).not.toBeNull();
    }
    // A checkable heading is a plain heading on the site: no control of any kind.
    expect(doc.querySelectorAll('input, button[role="checkbox"], [role="checkbox"]')).toHaveLength(
      0
    );
    expect(html).toContain('Part 1');
  });

  test('without an href (the staff view) there is no link, and the body renders as authored', async () => {
    const { html } = await renderSitePage({ blocks: fixture(), resolveLink: () => null });
    const doc = parse(html);
    expect(doc.querySelectorAll('a.bn-site-locked-link')).toHaveLength(0);
    expect(html).toContain('OUTER-SECRET-BODY');
    expect(html).toContain('INNER-SECRET-BODY');
  });
});
