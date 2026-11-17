/**
 * The slides app's write routes, run for real: each action module is imported
 * with its imports replaced by recording stubs (`importRouteWithStubs`), so
 * what the action does is visible without Postgres, a session or a content
 * repository. Kept real: React Router, the classroom-status rule
 * (`~/utils/classroomWrites`), the file-name rules (`~/utils/deckFiles`) and
 * the body readers.
 *
 * Pinned:
 *   - in a LOCKED classroom a teacher's write answers 403 and reaches no
 *     content-service call and no database write; the owner's goes through;
 *   - the deck action's reads stay open in a LOCKED classroom;
 *   - a delete-images path outside the deck's image folder, a theme or
 *     snippet id that is not one file name, or a theme type other than light
 *     or dark answers 400 with no content-service call.
 */
import { test, expect } from '@playwright/test';

import { callsTo, importRouteWithStubs, resetRouteStubs } from '../helpers/routeStubs.helpers.ts';

type Action = (args: {
  request: Request;
  params: Record<string, string | undefined>;
}) => Promise<unknown>;

const KEEP = [
  'react-router',
  '~/utils/classroomWrites',
  '~/utils/deckFiles',
  '@classmoji/utils',
  '@classmoji/utils/upload-limit',
  '@classmoji/utils/repo-limits',
  '@classmoji/utils/return-path',
  '~/utils/slideDocumentAccess',
];

const DECK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

let deck: Action;
let index: Action;
let create: Action;
let remove: Action;
let link: Action;
let replace: Action;
let htmlBlock: Action;

test.beforeAll(async () => {
  const load = async (file: string, keep: string[] = KEEP) =>
    (await importRouteWithStubs<{ action: Action }>(new URL(file, import.meta.url), keep)).action;
  deck = await load('../../app/routes/$slideId/route.tsx');
  index = await load('../../app/routes/_index/route.tsx');
  create = await load('../../app/routes/$classroomSlug.new/route.tsx');
  remove = await load('../../app/routes/$classroomSlug.$slideId.delete/route.tsx');
  link = await load('../../app/routes/$classroomSlug.$slideId.link/route.tsx');
  replace = await load('../../app/routes/$classroomSlug.$slideId.replace/route.tsx');
  htmlBlock = await load('../../app/routes/api.slides.$slideId.html-block/route.ts');
});

/** A slide row as the routes load it, in a classroom with `status`. */
const slideRow = (status: string, kind = 'DECK') => ({
  id: DECK_ID,
  title: 'Deck',
  kind,
  classroom_id: 'class-1',
  content_path: 'slides/deck-x',
  created_by: 'teacher-1',
  is_draft: false,
  is_public: false,
  allow_team_edit: false,
  show_speaker_notes: false,
  multiplex_id: null,
  source_url: 'https://example.test/a',
  classroom: {
    id: 'class-1',
    slug: 'class-x',
    status,
    content_repo: 'content',
    git_organization: { login: 'org', provider: 'GITHUB' },
  },
});

/** Stub returns for a caller with `role` on a deck in a `status` classroom. */
const setup = (status: string, role: string, kind = 'DECK') => {
  const slide = slideRow(status, kind);
  return resetRouteStubs({
    'getPrisma().slide.findUnique': async () => slide,
    getAuthSession: async () => ({ userId: 'user-1' }),
    assertSlideAccess: async () => ({ slide, userId: 'user-1', membership: { role } }),
    requireClassroomTeachingTeam: async () => ({
      userId: 'user-1',
      membership: { role },
      classroom: slide.classroom,
    }),
    authorizeLinkSlide: undefined,
    isDeckSlide: (s: { kind?: string }) => s?.kind === 'DECK',
    isDeckKind: (k: string) => k === 'DECK',
    liveEditingEnv: () => null,
    assertSlideInClassroom: () => undefined,
    assertSlideKind: () => undefined,
    'ContentService.deleteMultiple': async () => ({ deleted: 1, errors: [] }),
    'ContentService.put': async () => ({ sha: 'sha-1' }),
    'getPrisma().slide.update': async () => ({
      id: DECK_ID,
      title: 'T',
      classroom_id: 'class-1',
      kind: 'DECK',
      classroom: { collab_enabled: false },
    }),
  });
};

const form = (url: string, fields: Record<string, string>) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

const statusOf = (result: unknown): number =>
  result instanceof Response
    ? result.status
    : ((result as { init?: { status?: number } } | null)?.init?.status ?? 200);

const writes = () =>
  callsTo(
    'ContentService.',
    'getPrisma().slide.update',
    'getPrisma().slide.delete',
    'slideService.',
    'slideFileService.'
  );

const postDeck = (fields: Record<string, string>) =>
  deck({ request: form(`http://localhost/${DECK_ID}`, fields), params: { slideId: DECK_ID } });

const DECK_WRITES: Array<Record<string, string>> = [
  { intent: 'update-visibility', visibility: 'public' },
  { intent: 'save-theme', name: 'Ocean', type: 'light', content: 'x' },
  { intent: 'update-theme', id: 'ocean-light.css', name: 'Ocean', type: 'light', content: 'x' },
  { intent: 'delete-theme', id: 'ocean-light.css' },
  { intent: 'save-snippet', name: 'Box', content: 'x' },
  { intent: 'update-snippet', id: 'box.html', name: 'Box', content: 'x' },
  { intent: 'delete-snippet', id: 'box.html' },
  { intent: 'delete-images', paths: JSON.stringify(['slides/deck-x/images/a.png']) },
  { intent: 'collab-save-version' },
  { intent: 'preview-discard' },
];

test.describe('deck action in a LOCKED classroom', () => {
  for (const fields of DECK_WRITES) {
    test(`${fields.intent}: a teacher is refused and nothing is written`, async () => {
      setup('LOCKED', 'TEACHER');
      const result = await postDeck(fields);
      expect(statusOf(result)).toBe(403);
      expect((result as { data?: { code?: string } }).data?.code).toBe('CLASSROOM_LOCKED');
      expect(writes()).toEqual([]);
    });
  }

  test('a save with no intent is refused for a teacher', async () => {
    setup('LOCKED', 'TEACHER');
    const result = await postDeck({ content: '<section>x</section>' });
    expect(statusOf(result)).toBe(403);
    expect(writes()).toEqual([]);
  });

  test('the owner may write', async () => {
    setup('LOCKED', 'OWNER');
    const result = await postDeck({ intent: 'update-visibility', visibility: 'public' });
    expect(statusOf(result)).toBe(200);
    expect(callsTo('getPrisma().slide.update')).toHaveLength(1);
  });

  test('a teacher in an ACTIVE classroom may write', async () => {
    setup('ACTIVE', 'TEACHER');
    await postDeck({ intent: 'update-visibility', visibility: 'public' });
    expect(callsTo('getPrisma().slide.update')).toHaveLength(1);
  });

  test('reads stay open', async () => {
    setup('LOCKED', 'TEACHER');
    resetRouteStubs({
      ...setup('LOCKED', 'TEACHER').returns,
      'ContentService.listFolder': async () => [],
    });
    const result = await postDeck({ intent: 'list-themes' });
    expect(statusOf(result)).toBe(200);
    expect(result).toMatchObject({ intent: 'list-themes' });
  });
});

test.describe('deck action file intents (ACTIVE classroom, teacher)', () => {
  const refused: Array<Record<string, string>> = [
    { intent: 'delete-images', paths: JSON.stringify(['pages/page-x/content.json']) },
    { intent: 'delete-images', paths: JSON.stringify(['slides/deck-x/images/../deck.json']) },
    { intent: 'delete-images', paths: JSON.stringify(['slides/other/images/a.png']) },
    {
      intent: 'delete-images',
      paths: JSON.stringify(['slides/deck-x/images/a.png', 'slides/deck-x/deck.json']),
    },
    { intent: 'delete-images', paths: JSON.stringify([['slides/deck-x/images/a.png']]) },
    { intent: 'delete-theme', id: '../pages/x-light.css' },
    { intent: 'update-theme', id: 'a/b-light.css', name: 'x', type: 'light', content: 'x' },
    { intent: 'update-theme', id: 'ocean-light.css', name: 'x', type: '../x', content: 'x' },
    { intent: 'save-theme', name: 'x', type: 'sepia/../../x', content: 'x' },
    { intent: 'delete-snippet', id: '../../pages/x.html' },
    { intent: 'update-snippet', id: 'a\\b.html', name: 'x', content: 'x' },
  ];
  for (const fields of refused) {
    test(`${fields.intent} ${fields.paths ?? fields.id ?? fields.type}: 400, no content call`, async () => {
      setup('ACTIVE', 'TEACHER');
      const result = await postDeck(fields);
      expect(statusOf(result)).toBe(400);
      expect(callsTo('ContentService.')).toEqual([]);
    });
  }

  test("an image in the deck's own folder reaches the content service", async () => {
    setup('ACTIVE', 'TEACHER');
    await postDeck({
      intent: 'delete-images',
      paths: JSON.stringify(['slides/deck-x/images/a b%.png', 'slides/deck-x/images/.c.png']),
    });
    const [call] = callsTo('ContentService.deleteMultiple');
    expect((call.args[0] as { paths: string[] }).paths).toEqual([
      'slides/deck-x/images/a b%.png',
      'slides/deck-x/images/.c.png',
    ]);
  });

  test('a listed theme or snippet name reaches the content service', async () => {
    setup('ACTIVE', 'TEACHER');
    await postDeck({ intent: 'delete-theme', id: 'My Theme-light.css' });
    await postDeck({ intent: 'delete-snippet', id: 'My Snip.html' });
    expect(callsTo('ContentService.delete').map(c => (c.args[0] as { path: string }).path)).toEqual(
      ['.slidesthemes/My Theme-light.css', '.slidesthemes/snippets/My Snip.html']
    );
  });
});

test.describe('the other write routes in a LOCKED classroom', () => {
  const routes: Array<[string, () => Promise<unknown>, string?]> = [
    [
      'slides list delete',
      () =>
        index({
          request: form('http://localhost/?index', { intent: 'delete', slideId: DECK_ID }),
          params: {},
        }),
    ],
    [
      'slides list rename',
      () =>
        index({
          request: form('http://localhost/?index', {
            intent: 'rename',
            slideId: DECK_ID,
            title: 'T',
          }),
          params: {},
        }),
    ],
    [
      'slides list duplicate',
      () =>
        index({
          request: form('http://localhost/?index', { intent: 'duplicate', slideId: DECK_ID }),
          params: {},
        }),
    ],
    [
      'new slide',
      () =>
        create({
          request: form('http://localhost/class-x/new', { source: 'blank', title: 'New' }),
          params: { classroomSlug: 'class-x' },
        }),
    ],
    [
      'delete route',
      () =>
        remove({
          request: form(`http://localhost/class-x/${DECK_ID}/delete`, { deleteTheme: 'false' }),
          params: { classroomSlug: 'class-x', slideId: DECK_ID },
        }),
    ],
    [
      'edit link',
      () =>
        link({
          request: form(`http://localhost/class-x/${DECK_ID}/link`, {
            url: 'https://example.test/b',
          }),
          params: { classroomSlug: 'class-x', slideId: DECK_ID },
        }),
      'LINK',
    ],
    [
      'replace file',
      () =>
        replace({
          request: form(`http://localhost/class-x/${DECK_ID}/replace`, { mediaId: 'm-1' }),
          params: { classroomSlug: 'class-x', slideId: DECK_ID },
        }),
      'FILE',
    ],
    [
      'html-block save',
      () =>
        htmlBlock({
          request: new Request(`http://localhost/api/slides/${DECK_ID}/html-block`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ intent: 'save', html: '<p>x</p>' }),
          }),
          params: { slideId: DECK_ID },
        }),
    ],
  ];

  for (const [label, run, kind] of routes) {
    test(`${label}: a teacher gets 403 and nothing is written`, async () => {
      setup('LOCKED', 'TEACHER', kind);
      const result = await run();
      expect(statusOf(result)).toBe(403);
      expect(writes()).toEqual([]);
      expect(callsTo('handleHtmlBlockRequest', 'createFromForm')).toEqual([]);
    });

    test(`${label}: the owner gets past the rule`, async () => {
      setup('LOCKED', 'OWNER', kind);
      const result = await run().catch((error: unknown) => error);
      expect(statusOf(result)).not.toBe(403);
    });
  }

  // Where the route's write is a stubbed call, the owner's request reaches it.
  const ownerReaches: Array<[string, string]> = [
    ['slides list delete', 'slideService.deleteSlide'],
    ['slides list rename', 'getPrisma().slide.update'],
    ['delete route', 'slideService.deleteSlide'],
    ['edit link', 'slideFileService.updateSlideLink'],
    ['html-block save', 'handleHtmlBlockRequest'],
  ];
  for (const [label, write] of ownerReaches) {
    test(`${label}: the owner's request reaches ${write}`, async () => {
      const [, run, kind] = routes.find(([name]) => name === label)!;
      setup('LOCKED', 'OWNER', kind);
      await run().catch(() => undefined);
      expect(callsTo(write).length).toBeGreaterThan(0);
    });
  }
});

void OTHER_ID;
