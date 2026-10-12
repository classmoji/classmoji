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
  NO_SECTION_VIEWER,
  SECTION_NO_STORE_HEADERS,
  classroomOpenFor,
  documentForReader,
  documentForSite,
  handleSectionsGet,
  handleSectionsPost,
  impersonatorOf,
  isImpersonatedSession,
  parseSectionRequest,
  readerSectionsFor,
  sectionTargetValid,
  signInUrlFor,
  type PageSectionsDeps,
  type SectionViewerAccess,
  type SectionsPage,
} from '~/utils/pageSections.server.ts';
import { openLockedSections } from '~/components/viewer/sections/sectionCheckbox.ts';
import {
  SECTION_CHECK_GUTTER,
  clipLeftOf,
  sectionCheckLayout,
} from '~/components/viewer/sections/useSectionCheckGutter.ts';
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
              props: { title: 'Outer title' },
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
                  props: { title: 'Inner title' },
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
              props: { title: 'Solo title' },
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

/**
 * The reader rule, as `ClassmojiService.pageSections.sectionViewer` computes
 * it from a user's membership rows (the rule itself is unit- and
 * integration-tested in packages/services; this mirror only feeds the fakes).
 */
function viewerFrom(rows: Array<{ role: string; accepted: boolean }>): SectionViewerAccess {
  const rank: Record<string, number> = { OWNER: 4, TEACHER: 3, ASSISTANT: 2, STUDENT: 1 };
  const highest = (roles: string[]) =>
    roles.reduce<string | null>((best, r) => (!best || rank[r]! > rank[best]! ? r : best), null);
  const role = highest(rows.map(r => r.role));
  const acceptedRole = highest(rows.filter(r => r.accepted).map(r => r.role));
  const teachingTeam = acceptedRole !== null && acceptedRole !== 'STUDENT';
  const student = acceptedRole === 'STUDENT';
  const canEditAnyState = role === 'OWNER' || role === 'TEACHER';
  const revealAll = canEditAnyState || teachingTeam;
  return {
    role,
    acceptedRole,
    teachingTeam,
    student,
    canEditAnyState,
    revealAll,
    canUnlock: student && !revealAll,
    canSeeActivity: acceptedRole === 'OWNER' || acceptedRole === 'TEACHER',
    canViewDrafts: role !== null && role !== 'STUDENT',
  };
}

const STUDENT_VIEWER = viewerFrom([{ role: 'STUDENT', accepted: true }]);
const TA_VIEWER = viewerFrom([{ role: 'ASSISTANT', accepted: true }]);

test.describe('who sees locked bodies', () => {
  test('the classroom entry rule: LOCKED stays open, UNPUBLISHED only for its owner', () => {
    const owner = viewerFrom([{ role: 'OWNER', accepted: true }]);
    const teacher = viewerFrom([{ role: 'TEACHER', accepted: true }]);
    for (const viewer of [owner, teacher, TA_VIEWER, STUDENT_VIEWER]) {
      expect(classroomOpenFor({ status: 'ACTIVE', viewer })).toBe(true);
      expect(classroomOpenFor({ status: 'LOCKED', viewer })).toBe(true);
    }
    expect(classroomOpenFor({ status: 'UNPUBLISHED', viewer: owner })).toBe(true);
    for (const viewer of [teacher, TA_VIEWER, STUDENT_VIEWER, NO_SECTION_VIEWER]) {
      expect(classroomOpenFor({ status: 'UNPUBLISHED', viewer })).toBe(false);
    }
    // A pending owner invite is the owner's role for the entry gate (as MCP reads it).
    const pendingOwner = viewerFrom([{ role: 'OWNER', accepted: false }]);
    expect(classroomOpenFor({ status: 'UNPUBLISHED', viewer: pendingOwner })).toBe(true);
    expect(classroomOpenFor({ status: undefined, viewer: owner })).toBe(false);
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
        props: { title: '' },
        children: [{ id: 'x', type: 'paragraph', content: text('PROTO-SECRET') }],
      },
    ];
    const serialized = JSON.stringify(documentForReader(doc, { revealAll: false, unlocked: {} }));
    expect(serialized).not.toContain('PROTO-SECRET');
  });
});

test.describe('which locked sections the viewer shows open', () => {
  // The fixture with an extra, empty locked section ("empty") at the top level.
  const withEmpty = () => [
    ...fixture(),
    { id: 'empty', type: 'lockedSection', props: { title: 'Empty title' }, children: [] },
  ];
  const AT = '2026-10-12T00:00:00.000Z';

  test('a body in the editor is open', () => {
    const doc = withEmpty();
    expect(openLockedSections(doc, [], {})).toEqual(new Set(['outer', 'inner', 'solo']));
  });

  test('an unlocked section with no body is open; one withheld from the reader is not', () => {
    const unlocked = { empty: AT };
    const content = documentForReader(withEmpty(), { revealAll: false, unlocked });
    // The editor holds the redacted document: no body anywhere.
    const open = openLockedSections(content, content, unlocked);
    expect(open).toEqual(new Set(['empty']));
  });

  test('an unlock this visit that the loaded page does not carry is not open', () => {
    // Recorded locally, but the loader's unlocks (and so its content) predate it.
    const content = documentForReader(withEmpty(), { revealAll: false, unlocked: {} });
    expect(openLockedSections(content, content, {}).has('empty')).toBe(false);
    expect(openLockedSections(content, content, {}).has('solo')).toBe(false);
  });

  test('a body redacted for this reader is not taken for an empty one', () => {
    const content = documentForReader(withEmpty(), { revealAll: false, unlocked: {} });
    // `solo` is in the loader's unlocks only if its body was sent: with an
    // unlocks map that lacks it, its empty children mean withheld.
    expect(openLockedSections(content, content, { empty: AT }).has('solo')).toBe(false);
  });

  test('a nested section inside a body not sent is not open, even if unlocked', () => {
    const unlocked = { inner: AT };
    const content = documentForReader(withEmpty(), { revealAll: false, unlocked });
    expect(openLockedSections(content, content, unlocked).has('inner')).toBe(false);
  });

  test('the loaded unlocks are read as own keys only', () => {
    const content = [
      { id: 'constructor', type: 'lockedSection', props: { title: '' }, children: [] },
      { id: '__proto__', type: 'lockedSection', props: { title: '' }, children: [] },
    ];
    expect(openLockedSections(content, content, {}).size).toBe(0);
  });

  test('malformed input opens nothing and does not throw', () => {
    expect(openLockedSections(null, undefined, {}).size).toBe(0);
    expect(openLockedSections([null, 1, 'x'], [{ type: 'lockedSection' }], {}).size).toBe(0);
  });
});

test.describe('readerSections (the loader contract)', () => {
  const state = { checked: ['h-top'], unlocked: { solo: '2026-10-12T10:00:00.000Z' } };
  const base = { impersonated: false, classroomOpen: true };

  test('anonymous: all false and empty', () => {
    expect(
      readerSectionsFor({ ...base, signedIn: false, viewer: NO_SECTION_VIEWER, state: null })
    ).toEqual({
      staff: false,
      signedIn: false,
      canCheck: false,
      canUnlock: false,
      checked: [],
      unlocked: {},
    });
  });

  test('accepted student: can check and unlock, sees own state', () => {
    expect(readerSectionsFor({ ...base, signedIn: true, viewer: STUDENT_VIEWER, state })).toEqual({
      staff: false,
      signedIn: true,
      canCheck: true,
      canUnlock: true,
      ...state,
    });
  });

  test('impersonated student: sees the state, can do nothing', () => {
    const out = readerSectionsFor({
      ...base,
      signedIn: true,
      viewer: STUDENT_VIEWER,
      impersonated: true,
      state,
    });
    expect(out.canCheck).toBe(false);
    expect(out.canUnlock).toBe(false);
    expect(out.checked).toEqual(state.checked);
  });

  test('a classroom closed to the reader (UNPUBLISHED): state shown, nothing writable', () => {
    const out = readerSectionsFor({
      ...base,
      signedIn: true,
      viewer: STUDENT_VIEWER,
      classroomOpen: false,
      state,
    });
    expect(out).toMatchObject({ signedIn: true, canCheck: false, canUnlock: false });
    expect(out.unlocked).toEqual(state.unlocked);
  });

  test('teaching team: staff, may check, never unlock', () => {
    const out = readerSectionsFor({
      ...base,
      signedIn: true,
      viewer: TA_VIEWER,
      state: { checked: [], unlocked: {} },
    });
    expect(out).toMatchObject({ staff: true, canCheck: true, canUnlock: false });
  });

  test('student with a pending TEACHER invite (edits): staff, no unlock', () => {
    const out = readerSectionsFor({
      ...base,
      signedIn: true,
      viewer: viewerFrom([
        { role: 'STUDENT', accepted: true },
        { role: 'TEACHER', accepted: false },
      ]),
      state: { checked: [], unlocked: {} },
    });
    expect(out).toMatchObject({ staff: true, canCheck: true, canUnlock: false });
  });

  test('signed in without an accepted membership: no state even if handed one', () => {
    const out = readerSectionsFor({ ...base, signedIn: true, viewer: NO_SECTION_VIEWER, state });
    expect(out).toEqual({
      staff: false,
      signedIn: true,
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
    expect(impersonatorOf({ session: { session: { impersonatedBy: 'admin-id' } } })).toBe(
      'admin-id'
    );
    expect(impersonatorOf({ session: { session: { impersonatedBy: '' } } })).toBeNull();
    expect(impersonatorOf(null)).toBeNull();
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

const CLASS_LOCKED = 'class-locked';
const CLASS_UNPUBLISHED = 'class-unpublished';

type MemberRow = { role: string; accepted: boolean };
const accepted = (role: string): MemberRow => ({ role, accepted: true });
const pending = (role: string): MemberRow => ({ role, accepted: false });

/** Users and their membership rows (role + invite state), per classroom. */
const MEMBERS: Record<string, Record<string, MemberRow[]>> = {
  'student-1': {
    [CLASS_A]: [accepted('STUDENT')],
    [CLASS_LOCKED]: [accepted('STUDENT')],
    [CLASS_UNPUBLISHED]: [accepted('STUDENT')],
  },
  'student-2': { [CLASS_A]: [accepted('STUDENT')] },
  'ta-1': { [CLASS_A]: [accepted('ASSISTANT')] },
  'teacher-1': { [CLASS_A]: [accepted('TEACHER')], [CLASS_UNPUBLISHED]: [accepted('TEACHER')] },
  'owner-1': {
    [CLASS_A]: [accepted('OWNER')],
    [CLASS_LOCKED]: [accepted('OWNER')],
    [CLASS_UNPUBLISHED]: [accepted('OWNER')],
  },
  'owner-b': { [CLASS_B]: [accepted('OWNER')] },
  'student-b': { [CLASS_B]: [accepted('STUDENT')] },
  'pending-1': { [CLASS_A]: [pending('STUDENT')] },
  // An accepted student whose TEACHER invite is still pending: edits, so reveals all.
  'student-pending-teacher': { [CLASS_A]: [accepted('STUDENT'), pending('TEACHER')] },
  // A pending TEACHER (no accepted row): edits, but is no accepted member.
  'pending-teacher': { [CLASS_A]: [pending('TEACHER')] },
  // An accepted student with a pending ASSISTANT invite: still a student.
  'student-pending-ta': { [CLASS_A]: [accepted('STUDENT'), pending('ASSISTANT')] },
};

const inClass = (classroomId: string, status = 'ACTIVE') => ({
  classroom_id: classroomId,
  classroom: { status },
});

const PAGES: Record<string, Page> = {
  'page-a': { id: 'page-a', ...inClass(CLASS_A), is_draft: false, title: 'A' },
  'draft-a': { id: 'draft-a', ...inClass(CLASS_A), is_draft: true, title: 'Draft' },
  'page-b': { id: 'page-b', ...inClass(CLASS_B), is_draft: false, title: 'B' },
  'page-locked': {
    id: 'page-locked',
    ...inClass(CLASS_LOCKED, 'LOCKED'),
    is_draft: false,
    title: 'Archived',
  },
  'page-unpublished': {
    id: 'page-unpublished',
    ...inClass(CLASS_UNPUBLISHED, 'UNPUBLISHED'),
    is_draft: false,
    title: 'Unpublished',
  },
};

function makeDeps(overrides: Partial<PageSectionsDeps<Page>> = {}) {
  const calls = {
    setChecked: [] as unknown[],
    recordUnlock: [] as unknown[],
    sectionActivity: [] as unknown[],
    sectionViewer: [] as unknown[],
    audit: [] as unknown[],
    loadReaderBlocks: 0,
  };
  const unlocks: Record<string, Record<string, string>> = {}; // userId -> blockId -> iso
  const checkedKeys = new Set<string>(); // `${pageId}|${userId}|${blockId}`
  const deps: PageSectionsDeps<Page> = {
    async getSession(request) {
      const user = request.headers.get('x-user');
      if (!user) return null;
      const by = request.headers.get('x-impersonated-by');
      return {
        userId: user,
        impersonated: request.headers.get('x-impersonated') === '1' || Boolean(by),
        impersonatedBy: by,
      };
    },
    async findPage(id) {
      return PAGES[id] ?? null;
    },
    async sectionViewer({ userId, classroomId }) {
      calls.sectionViewer.push({ userId, classroomId });
      return viewerFrom(MEMBERS[userId]?.[classroomId] ?? []);
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
      if (args.page.classroom_id !== PAGES[args.page.id]?.classroom_id) return null;
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

function get(
  query: string,
  user?: string,
  { method = 'GET', impersonatedBy }: { method?: string; impersonatedBy?: string } = {}
) {
  const headers: Record<string, string> = {};
  if (user) headers['x-user'] = user;
  if (impersonatedBy) headers['x-impersonated-by'] = impersonatedBy;
  return new Request(`${ORIGIN}/api/page-sections?${query}`, { method, headers });
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

  test('a draft is 404 for a student, open to OWNER/TEACHER/ASSISTANT', async () => {
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
    // An accepted student whose pending TEACHER invite makes them an editor.
    expect(
      (
        await call(
          handleSectionsPost(
            post(
              { pageId: 'page-a', blockId: 'solo', intent: 'unlock' },
              { user: 'student-pending-teacher' }
            ),
            deps
          )
        )
      ).status
    ).toBe(409);
    expect(calls.recordUnlock).toEqual([]);
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
    const failed = await call(
      handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
        broken
      )
    );
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('db down');
    for (const [key, value] of Object.entries(SECTION_NO_STORE_HEADERS)) {
      expect(failed.headers.get(key)).toBe(value);
    }
  });

  test('a failing session lookup is a no-store 500, not a sign-in prompt', async () => {
    const { deps } = makeDeps({
      getSession: async () => {
        throw new Error('session store down');
      },
    });
    for (const res of [
      await call(
        handleSectionsPost(
          post({ pageId: 'page-a', blockId: 'h-top', intent: 'check' }, { user: 'student-1' }),
          deps
        )
      ),
      await call(handleSectionsGet(get('pageId=page-a&blockId=solo', 'owner-1'), deps)),
    ]) {
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  test('drafts follow the reader rule: pending teacher yes, pending assistant yes (bodies still redacted), plain student no', async () => {
    const { deps } = makeDeps();
    const draftCheck = (user: string, blockId = 'h-top') =>
      call(
        handleSectionsPost(post({ pageId: 'draft-a', blockId, intent: 'check' }, { user }), deps)
      );
    // Accepted student + pending TEACHER: edits, so the draft opens (as in the loader).
    expect((await draftCheck('student-pending-teacher')).status).toBe(200);
    // Accepted student + pending ASSISTANT: OWNER/TEACHER/ASSISTANT in any invite
    // state may open drafts (the pages app's existing rule)...
    expect((await draftCheck('student-pending-ta')).status).toBe(200);
    // ...but they do not reveal all: a heading inside a locked body is still
    // not there for them, while a revealing teacher reaches it.
    expect((await draftCheck('student-pending-ta', 'h-in-outer')).status).toBe(400);
    expect((await draftCheck('student-pending-teacher', 'h-in-outer')).status).toBe(200);
    // A plain accepted student still gets the draft as not found.
    expect((await draftCheck('student-2')).status).toBe(404);
  });

  test('archived (LOCKED) classrooms keep reader state; UNPUBLISHED keeps it for the owner only', async () => {
    const { deps, calls } = makeDeps();
    const send = (pageId: string, user: string, blockId = 'h-top', intent = 'check') =>
      call(handleSectionsPost(post({ pageId, blockId, intent }, { user }), deps));

    expect((await send('page-locked', 'student-1')).status).toBe(200);
    expect((await send('page-locked', 'student-1', 'solo', 'unlock')).status).toBe(200);
    expect((await send('page-locked', 'owner-1')).status).toBe(200);

    const refused = [
      await send('page-unpublished', 'student-1'),
      await send('page-unpublished', 'student-1', 'solo', 'unlock'),
      await send('page-unpublished', 'teacher-1'),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'CLASSROOM_UNPUBLISHED' });
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    expect((await send('page-unpublished', 'owner-1')).status).toBe(200);

    // Exactly the allowed writes reached the service.
    expect(calls.setChecked.map(c => (c as { userId: string }).userId)).toEqual([
      'student-1',
      'owner-1',
      'owner-1',
    ]);
    expect(calls.recordUnlock).toHaveLength(1);
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
        data: { tool: 'page_section_unlock', via: 'web', page_id: 'page-a', block_id: 'solo' },
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
    const checkRow = (checked: boolean) => ({
      tool: 'page_section_check',
      via: 'web',
      page_id: 'page-a',
      block_id: 'h-top',
      checked,
    });
    // Check rows skip the dedup window: each one is a real change.
    expect(calls.audit).toEqual([
      {
        userId: 'student-1',
        classroomId: CLASS_A,
        role: 'STUDENT',
        pageId: 'page-a',
        action: 'CREATE',
        data: checkRow(true),
        dedupe: false,
      },
      {
        userId: 'ta-1',
        classroomId: CLASS_A,
        role: 'ASSISTANT',
        pageId: 'page-a',
        action: 'CREATE',
        data: checkRow(true),
        dedupe: false,
      },
      {
        userId: 'ta-1',
        classroomId: CLASS_A,
        role: 'ASSISTANT',
        pageId: 'page-a',
        action: 'DELETE',
        data: checkRow(false),
        dedupe: false,
      },
    ]);
  });

  test('audit: the actor role is the ACCEPTED one (a pending teacher invite is not it)', async () => {
    const { deps, calls } = makeDeps();
    await handleSectionsPost(
      post(
        { pageId: 'page-a', blockId: 'h-top', intent: 'check' },
        { user: 'student-pending-teacher' }
      ),
      deps
    );
    expect(calls.audit).toHaveLength(1);
    expect(calls.audit[0]).toMatchObject({ role: 'STUDENT' });
  });

  test('audit: check → uncheck → check is three rows', async () => {
    const { deps, calls } = makeDeps();
    for (const intent of ['check', 'uncheck', 'check']) {
      await handleSectionsPost(
        post({ pageId: 'page-a', blockId: 'h-top', intent }, { user: 'student-1' }),
        deps
      );
    }
    expect(calls.audit.map(row => (row as { action: string }).action)).toEqual([
      'CREATE',
      'DELETE',
      'CREATE',
    ]);
    expect(calls.audit.every(row => (row as { dedupe?: boolean }).dedupe === false)).toBe(true);
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
      // The page row already loaded is the scope, and only unlocks are read.
      expect(calls.sectionActivity).toEqual([
        { page: { id: 'page-a', classroom_id: CLASS_A }, blockId: 'solo', only: 'unlocks' },
      ]);
      expect(calls.audit).toHaveLength(1);
      expect(calls.audit[0]).toEqual({
        userId: user,
        classroomId: CLASS_A,
        role: user === 'owner-1' ? 'OWNER' : 'TEACHER',
        pageId: 'page-a',
        action: 'VIEW',
        data: { tool: 'page_section_unlocks', via: 'web', page_id: 'page-a', block_id: 'solo' },
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
      // A pending TEACHER edits the page but sees no one's activity (MCP agrees).
      ['pageId=page-a&blockId=solo', 'pending-teacher'],
      ['pageId=page-a&blockId=solo', 'student-pending-teacher'],
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

  test('a HEAD request answers the same and writes no VIEW row', async () => {
    const { deps, calls } = makeDeps();
    const res = await handleSectionsGet(
      get('pageId=page-a&blockId=solo', 'teacher-1', { method: 'HEAD' }),
      deps
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(calls.audit).toEqual([]);
  });

  test('an impersonated view records who was viewing as the staff member', async () => {
    const { deps, calls } = makeDeps();
    await handleSectionsGet(
      get('pageId=page-a&blockId=solo', 'teacher-1', { impersonatedBy: 'admin-9' }),
      deps
    );
    expect(calls.audit).toHaveLength(1);
    expect((calls.audit[0] as { data: Record<string, unknown> }).data).toEqual({
      tool: 'page_section_unlocks',
      via: 'web',
      page_id: 'page-a',
      block_id: 'solo',
      impersonated_by: 'admin-9',
    });
  });

  test('UNPUBLISHED classroom: the list is the owner’s only (as the MCP entry gate)', async () => {
    const { deps, calls } = makeDeps();
    const teacher = await call(
      handleSectionsGet(get('pageId=page-unpublished&blockId=solo', 'teacher-1'), deps)
    );
    expect(teacher.status).toBe(403);
    expect(teacher.body).toMatchObject({ code: 'CLASSROOM_UNPUBLISHED' });
    const owner = await call(
      handleSectionsGet(get('pageId=page-unpublished&blockId=solo', 'owner-1'), deps)
    );
    expect(owner.status).toBe(200);
    expect(calls.sectionActivity).toHaveLength(1);
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
    // Reveal-all and edit come from the one shared reader rule.
    expect(loaderBody).toContain('const canEdit = sectionViewer.canEditAnyState;');
    expect(loaderBody).toContain('const revealAll = sectionViewer.revealAll;');
    // Drafts: OWNER/TEACHER/ASSISTANT in any invite state (locked bodies still follow revealAll).
    expect(loaderBody).toContain('if (page.is_draft && !sectionViewer.canViewDrafts) {');
  });

  test('one membership read, run with this reader’s own state; stats for activity viewers', () => {
    expect(loaderBody.match(/pageSections\.sectionViewer\(/g)).toHaveLength(1);
    expect(loaderBody).not.toContain('findClassroomRole(');
    expect(loaderBody).toMatch(
      /await Promise\.all\(\[\s*ClassmojiService\.pageSections\.sectionViewer/
    );
    expect(loaderBody).toContain('pageId: page.id,\n          userId: authData.userId,');
    expect(loaderBody).toMatch(
      /sectionViewer\.canSeeActivity && classroomOpen && lockedSectionIds\(viewerContent\)\.length > 0/
    );
    // The verified page row, so the service skips the page re-query.
    expect(loaderBody).toContain(
      'unlockCounts({\n          page: { id: page.id, classroom_id: page.classroom_id },'
    );
  });

  test('the raw source link is only for reveal-all readers', () => {
    expect(loaderBody).toMatch(/source_url:\s*revealAll && repoName/);
  });

  test('every response is private and uncached', () => {
    expect(LOADER).toMatch(/export const headers = /);
    expect(LOADER).toContain('SECTION_NO_STORE_HEADERS');
  });

  test('a sign-in link goes only to a signed-out reader', () => {
    expect(loaderBody).toContain('signInUrl: authData?.userId ? null : signInUrlFor(request.url),');
  });
});

test.describe('signInUrlFor', () => {
  test('the webapp sign-in page, redirect naming the page', () => {
    const previous = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'https://app.example';
    try {
      expect(signInUrlFor('https://pages.example/cs52/page-a?theme=dark')).toBe(
        'https://app.example?redirect=https%3A%2F%2Fpages.example%2Fcs52%2Fpage-a%3Ftheme%3Ddark'
      );
    } finally {
      if (previous === undefined) delete process.env.WEBAPP_URL;
      else process.env.WEBAPP_URL = previous;
    }
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

  test('a signed-out visitor gets one sign-in row per section, no card and no body', async () => {
    const signIn = '/sign-in?returnTo=%2Fweather';
    const { html } = await renderSitePage({
      blocks: documentForSite(fixture()),
      resolveLink: () => null,
      lockedSectionHref: 'https://pages.example/cs52/page-a',
      lockedSectionSignInHref: signIn,
    });
    for (const secret of [...SECRETS, 'Hidden step', 'outer-secret.png', MEDIA_ID]) {
      expect(html).not.toContain(secret);
    }
    const doc = parse(html);
    expect(doc.querySelectorAll('.bn-site-locked')).toHaveLength(0);
    expect(doc.querySelectorAll('a.bn-site-locked-link')).toHaveLength(0);
    const rows = [...doc.querySelectorAll('a.bn-site-locked-gate')];
    expect(rows.map(row => row.querySelector('.bn-site-locked-title')?.textContent)).toEqual([
      'Outer title',
      'Solo title',
    ]);
    for (const row of rows) {
      expect(row.getAttribute('href')).toBe(signIn);
      expect(row.getAttribute('aria-label')).toMatch(/^Sign in to unlock: /);
      expect(row.querySelector('svg.bn-site-locked-icon')).not.toBeNull();
      expect(row.querySelector('.bn-site-locked-tip')?.textContent).toBe('Sign in to unlock');
    }
  });

  test('the sign-in row is for anonymous renders only, through the site interstitial', () => {
    expect(body).toMatch(/lockedSectionSignInHref: context\.viewer\.userId\s*\? null/);
    expect(body).toContain('`${context.memberLinkOrigin}${signInPathFor(');
  });

  test('without an href (the staff view) there is no link, and the body renders as authored', async () => {
    const { html } = await renderSitePage({ blocks: fixture(), resolveLink: () => null });
    const doc = parse(html);
    expect(doc.querySelectorAll('a.bn-site-locked-link')).toHaveLength(0);
    expect(html).toContain('OUTER-SECRET-BODY');
    expect(html).toContain('INNER-SECRET-BODY');
  });
});

test.describe('the editor schema', () => {
  type SpecWithExtensions = { extensions?: Array<(ctx: { editor: unknown }) => { key?: string }> };
  const extensionKeys = (spec: SpecWithExtensions | undefined) =>
    (spec?.extensions ?? []).map(factory => factory({ editor: null })?.key);

  test('the editor’s locked section carries the edit guard; the shared one does not', async () => {
    const { schema } = await import('~/components/editor/blocks/index.tsx');
    const { editingSchema } = await import('~/components/editor/blocks/editingSchema.ts');
    const editing = editingSchema.blockSpecs as unknown as Record<string, SpecWithExtensions>;
    const shared = schema.blockSpecs as unknown as Record<string, SpecWithExtensions>;
    expect(extensionKeys(editing.lockedSection)).toContain('lockedSectionGuard');
    expect(extensionKeys(shared.lockedSection)).not.toContain('lockedSectionGuard');
  });

  test.describe('in a DOM', () => {
    const g = globalThis as Record<string, unknown>;
    const installed: string[] = [];
    test.beforeAll(() => {
      // Installed for this block only (other specs decide client-vs-server
      // on `window`); see file-block-upload-state.spec.ts.
      const dom = new UntypedJSDOM('<!doctype html><html><body></body></html>');
      for (const key of [
        'window',
        'document',
        'navigator',
        'Node',
        'HTMLElement',
        'Element',
        'MutationObserver',
        'getComputedStyle',
        'DocumentFragment',
        'Text',
      ]) {
        if (g[key] !== undefined) continue;
        g[key] = key === 'window' ? dom.window : (dom.window as Record<string, unknown>)[key];
        installed.push(key);
      }
    });
    test.afterAll(() => {
      for (const key of installed) delete g[key];
    });

    test('a checkable heading gets the author’s badge, named, outside the heading text', async () => {
      const { editingSchema } = await import('~/components/editor/blocks/editingSchema.ts');
      const spec = editingSchema.blockSpecs.heading as unknown as {
        implementation: {
          render: (
            block: unknown,
            editor: unknown
          ) => { dom: HTMLElement; contentDOM?: HTMLElement };
        };
      };
      const heading = (checkable?: boolean) => ({
        id: 'h',
        type: 'heading',
        props: {
          level: 2,
          isToggleable: false,
          textColor: 'default',
          backgroundColor: 'default',
          textAlignment: 'left',
          ...(checkable ? { checkable } : {}),
        },
        content: [],
        children: [],
      });
      const editor = { isEditable: true, schema: editingSchema };
      const on = spec.implementation.render(heading(true), editor);
      const badge = on.dom.querySelector('.pg-checkable-badge');
      expect(badge?.getAttribute('role')).toBe('img');
      expect(badge?.getAttribute('aria-label')).toBe('Checkable section');
      expect(badge?.getAttribute('title')).toBe('Checkable section');
      expect(on.contentDOM?.contains(badge as Node)).toBe(false);
      const off = spec.implementation.render(heading(), editor);
      expect(off.dom.querySelector('.pg-checkable-badge')).toBeNull();
    });

    test('the title field: Enter goes into the body, Backspace/Delete stay in the field', async () => {
      const { titleKeyAction, enterLockedSectionBody } =
        await import('~/components/editor/blocks/LockedSectionBlock.tsx');
      expect(titleKeyAction('Enter')).toBe('enter-body');
      expect(titleKeyAction('Backspace')).toBe('keep');
      expect(titleKeyAction('Delete')).toBe('keep');
      expect(titleKeyAction('a')).toBeNull();
      expect(titleKeyAction('ArrowDown')).toBeNull();

      const calls: unknown[][] = [];
      let children: Array<{ id: string }> = [];
      const editor = {
        isEditable: true,
        updateBlock: (id: string, update: unknown) => {
          calls.push(['updateBlock', id, update]);
          children = [{ id: 'new-p' }];
        },
        getBlock: (id: string) => ({ id, children }),
        setTextCursorPosition: (id: string, placement?: 'start' | 'end') =>
          calls.push(['cursor', id, placement]),
        focus: () => calls.push(['focus']),
      };
      // No body yet: an empty first line is added and the cursor goes there.
      enterLockedSectionBody(editor, 'L');
      expect(calls).toEqual([
        ['updateBlock', 'L', { children: [{ type: 'paragraph' }] }],
        ['focus'],
        ['cursor', 'new-p', 'start'],
      ]);
      // A body: straight to its first block, nothing added.
      calls.length = 0;
      enterLockedSectionBody(editor, 'L');
      expect(calls).toEqual([['focus'], ['cursor', 'new-p', 'start']]);
    });
  });
});

test.describe('the tick box gutter', () => {
  // JSDOM has no layout: each element's left edge is given by `data-left`.
  const page = (html: string) => {
    const doc = parse(html);
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
      const left = Number(el.dataset.left ?? 0);
      const size = el.dataset.collapsed === 'true' ? 0 : 100;
      el.getBoundingClientRect = () =>
        ({ left, top: 0, right: left + size, bottom: size, width: size, height: size }) as DOMRect;
    }
    return doc;
  };
  const heading = (left: number, extra = '') =>
    `<div class="bn-block-content" data-content-type="heading" data-checkable="true" data-left="${left}" ${extra}>` +
    `<h2>Title</h2><button class="pg-section-check"></button></div>`;

  test('the clip edge is the right-most clipping ancestor, or the window edge', () => {
    const doc = page(
      `<div style="overflow-x: hidden" data-left="40"><div data-left="300">` +
        `<div style="overflow-x: auto" data-left="240"><div id="viewer" data-left="250">${heading(264)}</div></div>` +
        `</div></div>`
    );
    const content = doc.querySelector('.bn-block-content')!;
    expect(clipLeftOf(content)).toBe(240);
    // No clipping ancestor (the page alone in a frame): the window's edge.
    expect(clipLeftOf(page(heading(24)).querySelector('.bn-block-content')!)).toBe(0);
  });

  test('inline when a shown box has less room than the gutter needs', () => {
    expect(sectionCheckLayout(page(`<div>${heading(24)}</div>`).body)).toBe('inline');
    expect(sectionCheckLayout(page(`<div>${heading(SECTION_CHECK_GUTTER)}</div>`).body)).toBe(
      'gutter'
    );
    // The room is counted from the clipping pane, not the window.
    const pane = (left: number) =>
      page(`<div style="overflow-x: auto" data-left="240">${heading(left)}</div>`).body;
    expect(sectionCheckLayout(pane(264))).toBe('inline');
    expect(sectionCheckLayout(pane(354))).toBe('gutter');
    // One tight heading puts every box inline.
    expect(sectionCheckLayout(page(heading(300) + heading(20)).body)).toBe('inline');
  });

  test('hidden boxes and collapsed headings are not measured', () => {
    expect(sectionCheckLayout(page(heading(20).replace('<button ', '<button hidden ')).body)).toBe(
      null
    );
    expect(sectionCheckLayout(page(heading(20, 'data-collapsed="true"')).body)).toBe(null);
    expect(sectionCheckLayout(page(heading(300) + heading(20, 'data-collapsed="true"')).body)).toBe(
      'gutter'
    );
    expect(sectionCheckLayout(page('<p>No checkable headings</p>').body)).toBe(null);
  });

  test('the inline layout is keyed on the measured attribute, not the viewport width', () => {
    const css = source('../../app/styles/page-sections.css');
    expect(css).not.toMatch(/@media \(max-width: 640px\)/);
    expect(css).toContain(".pg-reader-sections[data-section-checks='inline'] .pg-section-check {");
  });
});
