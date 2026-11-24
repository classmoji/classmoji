/**
 * `buildReaderPayload` (utils/readerPayload.server.ts): what a page's reader
 * receives, on every surface. Driven with fake I/O, so each leak case is
 * exact: viewer A vs B, classroom X vs Y, a signed-out reader, staff, an
 * impersonated session; the URL, download and link maps only ever hold what
 * the shipped document references; nothing from a stripped locked body
 * appears anywhere in the payload (its description included); the link
 * redaction cases the class site's old static render was held to apply here.
 */
import { test, expect } from '@playwright/test';
import { collectBlockAssetRefs } from '@classmoji/utils';

import {
  READER_LINKED_PAGES_MAX,
  appLinkPolicy,
  buildReaderPayload,
  type BuildReaderPayloadInput,
  type LinkedPageRow,
  type ReaderPayloadDeps,
  type ReaderViewer,
} from '~/utils/readerPayload.server.ts';
import { linkedPageIds, redactDocumentForViewer } from '~/utils/linkRedaction.server.ts';
import { NO_SECTION_VIEWER, type SectionViewerAccess } from '~/utils/pageSections.server.ts';
import type { ReaderPayload } from '~/utils/readerPayload.ts';
import { describeBlocks, navGridTiles, pageLinkRender } from '~/utils/readerPayload.ts';
import { inAppPageHref } from '~/components/reader/readerSurface.ts';

// ── Fixture: classroom X's page, linking around ──────────────────────────────

const X = 'class-x';
const Y = 'class-y';

const PAGES: LinkedPageRow[] = [
  {
    id: 'p-public',
    classroom_id: X,
    title: 'Public live title',
    slug: 'pub',
    is_public: true,
    is_draft: false,
  },
  {
    id: 'p-members',
    classroom_id: X,
    title: 'MEMBERS-ONLY-TITLE',
    slug: 'mem',
    is_public: false,
    is_draft: false,
  },
  {
    id: 'p-draft',
    classroom_id: X,
    title: 'DRAFT-TITLE',
    slug: 'dr',
    is_public: true,
    is_draft: true,
  },
  {
    id: 'p-secret-link',
    classroom_id: X,
    title: 'LINKED-FROM-SECRET',
    slug: 'sl',
    is_public: true,
    is_draft: false,
  },
  {
    id: 'p-other',
    classroom_id: Y,
    title: 'OTHER-CLASS-TITLE',
    slug: 'oc',
    is_public: true,
    is_draft: false,
  },
];

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const navEntries = (entries: unknown[]) => JSON.stringify(entries);

function documentFixture(): unknown[] {
  return [
    { id: 'h1', type: 'heading', props: { level: 1 }, content: text('Intro'), children: [] },
    {
      id: 'para',
      type: 'paragraph',
      props: {},
      content: text('Public text everyone in the class reads.'),
      children: [],
    },
    {
      id: 'pl-public',
      type: 'pageLink',
      props: { pageId: 'p-public', pageTitle: 'Stored public' },
      children: [],
    },
    {
      id: 'pl-members',
      type: 'pageLink',
      props: { pageId: 'p-members', pageTitle: 'STORED-MEMBERS-TITLE' },
      children: [],
    },
    {
      id: 'pl-draft',
      type: 'pageLink',
      props: { pageId: 'p-draft', pageTitle: 'STORED-DRAFT-TITLE' },
      children: [],
    },
    {
      id: 'pl-other',
      type: 'pageLink',
      props: { pageId: 'p-other', pageTitle: 'STORED-OTHER-TITLE' },
      children: [],
    },
    {
      id: 'pl-gone',
      type: 'pageLink',
      props: { pageId: 'p-gone', pageTitle: 'STORED-GONE-TITLE' },
      children: [],
    },
    {
      id: 'grid',
      type: 'navGrid',
      props: {
        columns: 2,
        entries: navEntries([
          { kind: 'page', pageId: 'p-public', title: '' },
          { kind: 'page', pageId: 'p-members', title: 'GRID-MEMBERS-LABEL' },
          { kind: 'page', pageId: 'p-other', title: 'GRID-OTHER-LABEL' },
          { kind: 'schedule' },
          { kind: 'external', url: 'https://example.com', label: 'Example' },
        ]),
      },
      children: [],
    },
    {
      id: 'lock',
      type: 'lockedSection',
      props: { title: 'Solution' },
      children: [
        {
          id: 'secret-p',
          type: 'paragraph',
          props: {},
          content: text('SECRET-BODY-TEXT'),
          children: [],
        },
        { id: 'secret-img', type: 'image', props: { url: 'pages/x/secret.png' }, children: [] },
        { id: 'secret-media', type: 'video', props: { url: 'media://secret-video' }, children: [] },
        {
          id: 'secret-link',
          type: 'pageLink',
          props: { pageId: 'p-secret-link', pageTitle: 'STORED-SECRET-LINK' },
          children: [],
        },
      ],
    },
    { id: 'img', type: 'image', props: { url: 'pages/x/public.png' }, children: [] },
    { id: 'video', type: 'video', props: { url: 'media://video-1' }, children: [] },
    { id: 'lost-media', type: 'file', props: { url: 'media://unresolvable' }, children: [] },
    { id: 'empty-file', type: 'file', props: { url: '' }, children: [] },
    {
      id: 'code',
      type: 'codeBlock',
      props: { language: 'js' },
      content: [{ type: 'link', href: 'https://x.test', content: text('let a = 1;') }],
      children: [],
    },
  ];
}

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Calls {
  resolved: unknown[];
  downloads: Array<{ classroomId: string; blocks: unknown; role: string }>;
  linked: Array<{ classroomId: string; ids: string[] }>;
  comments: Array<Record<string, unknown>>;
  schedule: number;
}

function fakes(options: { leakyLinks?: boolean; delivery?: boolean } = {}) {
  const calls: Calls = { resolved: [], downloads: [], linked: [], comments: [], schedule: 0 };
  const deps: ReaderPayloadDeps = {
    assetContext: () => (options.delivery === false ? null : { ctx: true }),
    resolveAssets: async (ctx, blocks, extra) => {
      calls.resolved.push(blocks);
      if (!ctx) return { assets: {}, srcSets: {} };
      const refs = [...collectBlockAssetRefs(blocks), ...extra.filter(Boolean)] as string[];
      const assets: Record<string, string> = {};
      const srcSets: Record<string, string> = {};
      for (const ref of refs) {
        if (ref.includes('unresolvable')) continue;
        assets[ref] = `https://cdn.test/${encodeURIComponent(ref)}`;
        if (ref.endsWith('.png')) srcSets[ref] = `https://cdn.test/${encodeURIComponent(ref)} 1x`;
      }
      return { assets, srcSets };
    },
    loadMediaDownloads: async (classroomId, blocks, role) => {
      calls.downloads.push({ classroomId, blocks, role });
      const out: Record<string, boolean> = {};
      for (const ref of collectBlockAssetRefs(blocks))
        if (ref.startsWith('media://')) out[ref] = true;
      return out;
    },
    linkedPages: async (classroomId, ids) => {
      calls.linked.push({ classroomId, ids });
      return PAGES.filter(
        row => ids.includes(row.id) && (options.leakyLinks || row.classroom_id === classroomId)
      );
    },
    readerComments: async args => {
      calls.comments.push(args as unknown as Record<string, unknown>);
      return {
        counts: {},
        pageLevel: 0,
        open: 0,
        canWrite: true,
        canResolve: false,
        frozen: false,
      };
    },
  };
  return { deps, calls };
}

const access = (over: Partial<SectionViewerAccess>): SectionViewerAccess => ({
  ...NO_SECTION_VIEWER,
  ...over,
});

const STUDENT = access({
  role: 'STUDENT',
  acceptedRole: 'STUDENT',
  student: true,
  canUnlock: true,
});
const STAFF = access({
  role: 'OWNER',
  acceptedRole: 'OWNER',
  teachingTeam: true,
  canEditAnyState: true,
  revealAll: true,
  canSeeActivity: true,
  canViewDrafts: true,
});

function viewer(
  userId: string,
  a: SectionViewerAccess,
  over: { unlocked?: Record<string, string>; checked?: string[]; impersonated?: boolean } = {}
): ReaderViewer {
  const impersonated = over.impersonated === true;
  const canCheck = a.acceptedRole !== null && !impersonated;
  return {
    userId,
    access: a,
    impersonated,
    readerSections: {
      staff: a.revealAll,
      signedIn: true,
      canCheck,
      canUnlock: canCheck && a.canUnlock,
      checked: over.checked ?? [],
      unlocked: over.unlocked ?? {},
    },
  };
}

function input(
  who: ReaderViewer | null,
  over: Partial<BuildReaderPayloadInput> & { blocks?: unknown; schedule?: string | null } = {},
  calls?: Calls
): BuildReaderPayloadInput {
  return {
    content: {
      blocks: over.blocks ?? documentFixture(),
      cover: { url: 'pages/x/cover.png', position: 30 },
      format: 'json',
    },
    page: { id: 'page-1', classroom_id: X, is_draft: false, is_public: true },
    classroom: { id: X, slug: 'cs-x' },
    viewer: who,
    options: { tier: 'week', previewActive: false, surface: 'app' },
    signInUrl: () => 'https://webapp.test/?redirect=page-1',
    links: appLinkPolicy('cs-x'),
    scheduleHref: async () => {
      if (calls) calls.schedule += 1;
      return over.schedule === undefined ? null : over.schedule;
    },
    ...over,
  };
}

const wire = (payload: ReaderPayload) => JSON.stringify(payload);
const SECRETS = [
  'SECRET-BODY-TEXT',
  'secret.png',
  'secret-video',
  'p-secret-link',
  'LINKED-FROM-SECRET',
  'STORED-SECRET-LINK',
];
const HIDDEN_TITLES = [
  'MEMBERS-ONLY-TITLE',
  'STORED-MEMBERS-TITLE',
  'GRID-MEMBERS-LABEL',
  'DRAFT-TITLE',
  'STORED-DRAFT-TITLE',
];
const OTHER_CLASS = ['OTHER-CLASS-TITLE', 'STORED-OTHER-TITLE', 'GRID-OTHER-LABEL', 'p-other'];

/** Every ref the shipped payload's document holds, plus its cover. */
const shippedRefs = (payload: ReaderPayload) =>
  new Set([
    ...collectBlockAssetRefs(payload.content),
    ...(payload.coverImage ? [payload.coverImage.url] : []),
  ]);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('buildReaderPayload — a signed-out reader', () => {
  test('gets only public pages as links, no hidden title anywhere, no locked body', async () => {
    const { deps, calls } = fakes();
    const payload = await buildReaderPayload(input(null, {}, undefined), deps);
    expect(Object.keys(payload.links)).toEqual(['p-public']);
    expect(payload.links['p-public']).toEqual({
      href: '/cs-x/p-public',
      title: 'Public live title',
      membersOnly: false,
    });
    expect(Object.values(payload.links).some(link => link.membersOnly)).toBe(false);
    const json = wire(payload);
    for (const secret of [
      ...SECRETS,
      ...HIDDEN_TITLES,
      ...OTHER_CLASS,
      'STORED-GONE-TITLE',
      'p-gone',
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    // Nothing from the locked body ever reached the resolver either.
    expect(JSON.stringify(calls.resolved)).not.toContain('secret');
    expect(payload.signInUrl).toBe('https://webapp.test/?redirect=page-1');
    expect(payload.readerSections).toMatchObject({
      signedIn: false,
      canCheck: false,
      checked: [],
      unlocked: {},
    });
    expect(payload.readerComments).toBeUndefined();
    expect(payload.mediaDownloads).toEqual({});
    expect(calls.downloads).toHaveLength(0);
    expect(calls.comments).toHaveLength(0);
  });

  test('the schedule tile is dropped when there is no schedule, kept when there is', async () => {
    const without = fakes();
    const dropped = await buildReaderPayload(input(null, {}, without.calls), without.deps);
    expect(without.calls.schedule).toBe(1);
    expect(dropped.scheduleHref).toBeNull();
    const grid = dropped.content.find(b => (b as { id?: string }).id === 'grid') as {
      props: { entries: string };
    };
    expect(JSON.parse(grid.props.entries).map((e: { kind: string }) => e.kind)).toEqual([
      'page',
      'external',
    ]);

    const withSchedule = fakes();
    const kept = await buildReaderPayload(
      input(null, { schedule: 'https://cs.site.test/schedule' }, withSchedule.calls),
      withSchedule.deps
    );
    expect(kept.scheduleHref).toBe('https://cs.site.test/schedule');
    const keptGrid = kept.content.find(b => (b as { id?: string }).id === 'grid') as {
      props: { entries: string };
    };
    expect(JSON.parse(keptGrid.props.entries).map((e: { kind: string }) => e.kind)).toEqual([
      'page',
      'schedule',
      'external',
    ]);
  });

  test('the schedule is not asked for when no directory has the tile', async () => {
    const { deps, calls } = fakes();
    await buildReaderPayload(input(null, { blocks: [documentFixture()[1]] }, calls), deps);
    expect(calls.schedule).toBe(0);
  });
});

test.describe('buildReaderPayload — maps hold only what ships', () => {
  for (const [name, who] of [
    ['signed out', null],
    ['student', viewer('student-a', STUDENT)],
    ['staff', viewer('owner', STAFF)],
  ] as const) {
    test(`${name}: URL, srcset, download and link map keys ⊆ the shipped document (+ cover)`, async () => {
      const { deps } = fakes();
      const payload = await buildReaderPayload(input(who), deps);
      const refs = shippedRefs(payload);
      for (const key of Object.keys(payload.assets)) expect(refs.has(key), key).toBe(true);
      for (const key of Object.keys(payload.srcSets)) expect(refs.has(key), key).toBe(true);
      for (const key of Object.keys(payload.mediaDownloads)) expect(refs.has(key), key).toBe(true);
      const linked = new Set(linkedPageIds(payload.content));
      for (const key of Object.keys(payload.links)) expect(linked.has(key), key).toBe(true);
    });
  }

  test('an unresolved media reference is emptied; a repo path with no URL survives', async () => {
    const { deps } = fakes({ delivery: false });
    const payload = await buildReaderPayload(input(viewer('student-a', STUDENT)), deps);
    const refs = collectBlockAssetRefs(payload.content);
    expect(refs.some(ref => ref.startsWith('media://'))).toBe(false);
    expect(refs).toContain('pages/x/public.png');
    expect(payload.coverImage).toEqual({ url: 'pages/x/cover.png', position: 30 });
    // No resolve context: no download buttons either (the route could mint nothing).
    expect(payload.mediaDownloads).toEqual({});

    const resolving = fakes();
    const resolved = await buildReaderPayload(input(viewer('student-a', STUDENT)), resolving.deps);
    const resolvedRefs = collectBlockAssetRefs(resolved.content);
    expect(resolvedRefs).toContain('media://video-1');
    expect(resolvedRefs).not.toContain('media://unresolvable');
    expect(resolved.mediaDownloads).toEqual({ 'media://video-1': true });
  });

  test('a media cover nobody signed is dropped', async () => {
    const { deps } = fakes({ delivery: false });
    const payload = await buildReaderPayload(
      {
        ...input(null),
        content: { blocks: [], cover: { url: 'media://cover', position: 50 }, format: 'json' },
      },
      deps
    );
    expect(payload.coverImage).toBeNull();
  });

  test('code blocks ship as plain text, unset file blocks as nothing', async () => {
    const { deps } = fakes();
    const payload = await buildReaderPayload(input(null), deps);
    const code = payload.content.find(b => (b as { id?: string }).id === 'code') as {
      content: unknown;
    };
    expect(code.content).toEqual([{ type: 'text', text: 'let a = 1;', styles: {} }]);
    expect(wire(payload)).not.toContain('"id":"empty-file"');
  });

  test('never mutates the content it was given', async () => {
    const { deps } = fakes();
    const blocks = deepFreeze(documentFixture());
    const before = JSON.stringify(blocks);
    for (const who of [
      null,
      viewer('student-a', STUDENT, { unlocked: { lock: 't' } }),
      viewer('owner', STAFF),
    ]) {
      await buildReaderPayload(input(who, { blocks }), deps);
    }
    expect(JSON.stringify(blocks)).toBe(before);
  });
});

test.describe('buildReaderPayload — viewer A vs viewer B', () => {
  test("A's unlock gives A the body and its links; B gets neither, anywhere", async () => {
    const { deps, calls } = fakes();
    const a = await buildReaderPayload(
      input(
        viewer('student-a', STUDENT, {
          unlocked: { lock: '2026-11-01T00:00:00Z' },
          checked: ['h1'],
        })
      ),
      deps
    );
    const b = await buildReaderPayload(input(viewer('student-b', STUDENT)), deps);
    expect(wire(a)).toContain('SECRET-BODY-TEXT');
    expect(a.links['p-secret-link']?.title).toBe('LINKED-FROM-SECRET');
    expect(Object.keys(a.assets)).toContain('pages/x/secret.png');
    for (const secret of SECRETS) expect(wire(b), secret).not.toContain(secret);
    expect(b.description ?? '').not.toContain('SECRET');
    // Each reader's own state, passed through untouched.
    expect(a.readerSections.checked).toEqual(['h1']);
    expect(b.readerSections.checked).toEqual([]);
    expect(b.readerSections.unlocked).toEqual({});
    // Comments asked for each reader as themselves.
    expect(calls.comments.map(c => c.userId)).toEqual(['student-a', 'student-b']);
    expect(calls.comments[0].unlockedSectionIds).toEqual(['lock']);
    expect(calls.comments[1].unlockedSectionIds).toEqual([]);
  });

  test('a member sees members-only pages, marked; never drafts', async () => {
    const { deps } = fakes();
    const payload = await buildReaderPayload(input(viewer('student-a', STUDENT)), deps);
    expect(Object.keys(payload.links).sort()).toEqual(['p-members', 'p-public']);
    expect(payload.links['p-members'].membersOnly).toBe(true);
    for (const hidden of ['DRAFT-TITLE', 'STORED-DRAFT-TITLE'])
      expect(wire(payload)).not.toContain(hidden);
    expect(payload.signInUrl).toBeNull();
  });

  test('a signed-in non-member of a public page: like signed out, but no sign-in link', async () => {
    const { deps, calls } = fakes();
    const payload = await buildReaderPayload(
      input(viewer('stranger', NO_SECTION_VIEWER as SectionViewerAccess)),
      deps
    );
    expect(Object.keys(payload.links)).toEqual(['p-public']);
    for (const hidden of [...HIDDEN_TITLES, ...SECRETS])
      expect(wire(payload)).not.toContain(hidden);
    expect(payload.signInUrl).toBeNull();
    expect(calls.comments).toHaveLength(0);
    expect(calls.downloads).toHaveLength(0);
  });
});

test.describe('buildReaderPayload — classroom X vs Y', () => {
  test('a page of another classroom is never a link, even if the lookup returned it', async () => {
    const { deps, calls } = fakes({ leakyLinks: true });
    for (const who of [null, viewer('student-a', STUDENT), viewer('owner', STAFF)]) {
      const payload = await buildReaderPayload(input(who), deps);
      expect(payload.links['p-other']).toBeUndefined();
      for (const other of OTHER_CLASS) expect(wire(payload), other).not.toContain(other);
    }
    // The lookup itself is scoped to the PAGE's classroom.
    expect(new Set(calls.linked.map(call => call.classroomId))).toEqual(new Set([X]));
  });

  test('downloads are looked up in the page’s classroom only', async () => {
    const { deps, calls } = fakes();
    await buildReaderPayload(input(viewer('student-a', STUDENT)), deps);
    expect(calls.downloads.map(call => call.classroomId)).toEqual([X]);
    expect(calls.downloads[0].role).toBe('STUDENT');
  });
});

test.describe('buildReaderPayload — staff, previews, impersonation', () => {
  test('staff: every locked body, drafts and members-only pages as links', async () => {
    const { deps } = fakes();
    const payload = await buildReaderPayload(input(viewer('owner', STAFF)), deps);
    expect(wire(payload)).toContain('SECRET-BODY-TEXT');
    expect(Object.keys(payload.links).sort()).toEqual([
      'p-draft',
      'p-members',
      'p-public',
      'p-secret-link',
    ]);
    expect(payload.links['p-members'].membersOnly).toBe(true);
    expect(payload.readerSections.staff).toBe(true);
  });

  test('a preview: no comments; offerDownloads false: no download buttons', async () => {
    const preview = fakes();
    const p = await buildReaderPayload(
      {
        ...input(viewer('owner', STAFF)),
        options: { tier: 'edit', previewActive: true, surface: 'app' },
      },
      preview.deps
    );
    expect(p.readerComments).toBeUndefined();
    expect(preview.calls.comments).toHaveLength(0);
    expect(Object.keys(p.mediaDownloads).length).toBeGreaterThan(0);

    const withheld = fakes();
    const w = await buildReaderPayload(
      {
        ...input(viewer('owner', STAFF)),
        options: { tier: 'edit', previewActive: false, surface: 'app', offerDownloads: false },
      },
      withheld.deps
    );
    expect(w.mediaDownloads).toEqual({});
    expect(withheld.calls.downloads).toHaveLength(0);
  });

  test('impersonated: passed through to comments as is; section state as the caller made it', async () => {
    const { deps, calls } = fakes();
    const payload = await buildReaderPayload(
      input(viewer('student-a', STUDENT, { impersonated: true })),
      deps
    );
    expect(calls.comments[0].impersonated).toBe(true);
    expect(payload.readerSections.canCheck).toBe(false);
    expect(payload.readerSections.canUnlock).toBe(false);
  });

  test('a non-json read ships the empty document', async () => {
    const { deps } = fakes();
    const payload = await buildReaderPayload(
      {
        ...input(viewer('owner', STAFF)),
        content: { blocks: '<p>Old</p>', cover: null, format: 'html' },
      },
      deps
    );
    expect(payload.content).toEqual([{ type: 'paragraph', content: [] }]);
  });
});

// ── Hardening (review fixes) ────────────────────────────────────────────────

const ofType = (payload: ReaderPayload, type: string) =>
  JSON.stringify(payload.content).split(`"type":"${type}"`).length - 1;

test.describe('buildReaderPayload — hardening', () => {
  test('malformed directory entries never carry a hidden title through', async () => {
    const blocks = [
      {
        id: 'g1',
        type: 'navGrid',
        props: { entries: '[{"kind":"Page","pageId":"HIDDEN","title":"Exam 2 Solutions"}]' },
        children: [],
      },
      {
        id: 'g2',
        type: 'navGrid',
        props: { entries: '[{"kind":"page","pageId":12345,"title":"Exam 2 Solutions"}]' },
        children: [],
      },
      {
        id: 'g3',
        type: 'navGrid',
        props: { entries: '[{"kind":"page","pageId":"HIDDEN","title":"Exam 2 Solutions"' },
        children: [],
      },
      {
        id: 'g4',
        type: 'navGrid',
        props: {
          entries: navEntries([
            { kind: 'page', pageId: 'p-public', title: '' },
            { kind: 'page', pageId: 'HIDDEN', title: 'Exam 2 Solutions' },
          ]),
        },
        children: [],
      },
    ];
    for (const who of [null, viewer('student-a', STUDENT), viewer('owner', STAFF)]) {
      const { deps } = fakes();
      const payload = await buildReaderPayload(input(who, { blocks }), deps);
      expect(wire(payload)).not.toContain('Exam 2 Solutions');
      expect(wire(payload)).not.toContain('HIDDEN');
      expect(ofType(payload, 'navGrid')).toBe(4);
    }
  });

  test('a visible pageLink carries the live title and only its own props', async () => {
    const { deps } = fakes();
    const payload = await buildReaderPayload(
      input(null, {
        blocks: [
          {
            id: 'pl',
            type: 'pageLink',
            props: { pageId: 'p-public', pageTitle: 'OLD-CACHED-TITLE', note: 'X-EXTRA-PROP' },
            children: [],
          },
        ],
      }),
      deps
    );
    expect(payload.content).toEqual([
      {
        id: 'pl',
        type: 'pageLink',
        props: { pageId: 'p-public', pageTitle: 'Public live title' },
        children: [],
      },
    ]);
  });

  test('hidden links and unset files are removed, not left as blank lines', async () => {
    const { deps } = fakes();
    const payload = await buildReaderPayload(input(null), deps);
    const ids = JSON.stringify(payload.content);
    for (const gone of ['pl-members', 'pl-draft', 'pl-other', 'pl-gone', 'empty-file']) {
      expect(ids, gone).not.toContain(`"id":"${gone}"`);
    }
    // No empty paragraph stands in for them.
    expect(ids).not.toContain('"type":"paragraph","content":[]');
    expect(ids).not.toContain('{"type":"paragraph"');
  });

  test('a removed block’s children stay, in its place', async () => {
    const { deps } = fakes();
    const payload = await buildReaderPayload(
      input(null, {
        blocks: [
          {
            id: 'hidden',
            type: 'pageLink',
            props: { pageId: 'p-members' },
            children: [{ id: 'kid', type: 'paragraph', content: text('Kept child'), children: [] }],
          },
        ],
      }),
      deps
    );
    expect(payload.content).toEqual([
      { id: 'kid', type: 'paragraph', content: text('Kept child'), children: [] },
    ]);
  });

  test('a column list never ships with fewer than two columns', async () => {
    const column = (id: string, children: unknown[]) => ({
      id,
      type: 'column',
      props: {},
      children,
    });
    const para = (id: string) => ({ id, type: 'paragraph', content: text(id), children: [] });
    const hidden = (id: string) => ({
      id,
      type: 'pageLink',
      props: { pageId: 'p-members' },
      children: [],
    });
    const { deps } = fakes();
    const two = await buildReaderPayload(
      input(null, {
        blocks: [
          {
            id: 'cl',
            type: 'columnList',
            props: {},
            children: [column('c1', [hidden('h1')]), column('c2', [para('right')])],
          },
        ],
      }),
      deps
    );
    // Unwrapped: the remaining column's blocks in its place.
    expect(two.content).toEqual([para('right')]);

    const three = await buildReaderPayload(
      input(null, {
        blocks: [
          {
            id: 'cl',
            type: 'columnList',
            props: {},
            children: [
              column('c1', [hidden('h1')]),
              column('c2', [para('mid')]),
              column('c3', [para('right')]),
            ],
          },
        ],
      }),
      deps
    );
    const list = three.content[0] as { type: string; children: Array<{ id: string }> };
    expect(list.type).toBe('columnList');
    expect(list.children.map(c => c.id)).toEqual(['c2', 'c3']);
  });

  test('media that could not be resolved is removed, and its map entries with it', async () => {
    const UUID_A = '11111111-1111-4111-8111-111111111111';
    const UUID_C = '33333333-3333-4333-8333-333333333333';
    const placeholder = `https://content.test/c/${UUID_C}/missing/media%3A%2F%2F${UUID_A}`;
    const { deps } = fakes();
    const resolveAssets = deps.resolveAssets;
    deps.resolveAssets = async (ctx, blocks, extra) => {
      const out = await resolveAssets(ctx, blocks, extra);
      out.assets[`media://${UUID_A}`] = placeholder;
      return out;
    };
    const payload = await buildReaderPayload(
      input(viewer('student-a', STUDENT), {
        blocks: [
          {
            id: 'placeholder-image',
            type: 'image',
            props: { url: `media://${UUID_A}` },
            children: [],
          },
          {
            id: 'unanswered-file',
            type: 'file',
            props: { url: 'media://unresolvable' },
            children: [],
          },
          { id: 'audio-ok', type: 'audio', props: { url: 'pages/x/a.mp3' }, children: [] },
          // A profile's photo is an asset prop too (`imageUrl`): the card
          // stays, its unresolved photo is emptied.
          {
            id: 'profile-placeholder',
            type: 'profile',
            props: { name: 'Ada', imageUrl: `media://${UUID_A}` },
            children: [],
          },
          {
            id: 'profile-unanswered',
            type: 'profile',
            props: { name: 'Grace', imageUrl: 'media://unresolvable' },
            children: [],
          },
          {
            id: 'profile-ok',
            type: 'profile',
            props: { name: 'Alan', imageUrl: 'pages/x/alan.png' },
            children: [],
          },
        ],
      }),
      deps
    );
    expect(payload.content.map(b => (b as { id: string }).id)).toEqual([
      'audio-ok',
      'profile-placeholder',
      'profile-unanswered',
      'profile-ok',
    ]);
    const photos = payload.content
      .filter(b => (b as { type: string }).type === 'profile')
      .map(b => (b as { props: { name: string; imageUrl: string } }).props);
    expect(photos).toEqual([
      { name: 'Ada', imageUrl: '' },
      { name: 'Grace', imageUrl: '' },
      { name: 'Alan', imageUrl: 'pages/x/alan.png' },
    ]);
    expect(wire(payload)).not.toContain('media://');
    expect(payload.assets[`media://${UUID_A}`]).toBeUndefined();
    expect(Object.keys(payload.mediaDownloads)).toEqual([]);
  });

  test('a document naming more pages than the cap: each id once, the rest not links', async () => {
    const many = Array.from({ length: READER_LINKED_PAGES_MAX + 500 }, (_, i) => ({
      id: `l${i}`,
      type: 'pageLink',
      props: {
        pageId:
          i === READER_LINKED_PAGES_MAX + 100
            ? 'p-public'
            : `missing-${i % (READER_LINKED_PAGES_MAX + 400)}`,
      },
      children: [],
    }));
    const { deps, calls } = fakes();
    const payload = await buildReaderPayload(input(null, { blocks: many }), deps);
    expect(calls.linked).toHaveLength(1);
    expect(calls.linked[0].ids.length).toBeLessThanOrEqual(READER_LINKED_PAGES_MAX);
    expect(new Set(calls.linked[0].ids).size).toBe(calls.linked[0].ids.length);
    // p-public sits beyond the cap: not resolved, so not a link.
    expect(payload.links['p-public']).toBeUndefined();
    expect(payload.content).toEqual([]);
  });
});

test.describe('no classroom slug: no link, no navigation', () => {
  test('inAppPageHref refuses to build an address without a slug or page', () => {
    expect(inAppPageHref('', 'p1')).toBeNull();
    expect(inAppPageHref(null, 'p1')).toBeNull();
    expect(inAppPageHref(undefined, 'p1')).toBeNull();
    expect(inAppPageHref('cs1', '')).toBeNull();
    expect(inAppPageHref('cs1', 'p1', '?embed=true&theme=dark&preview=1')).toBe(
      '/cs1/p1?embed=true&theme=dark'
    );
  });

  test('the app link rule opens nothing without a slug, and the builder drops `//` hrefs', async () => {
    expect(appLinkPolicy('').canOpen(PAGES[0], null)).toBe(false);
    const { deps } = fakes();
    const payload = await buildReaderPayload(
      input(viewer('owner', STAFF), { links: { canOpen: () => true, href: row => `//${row.id}` } }),
      deps
    );
    expect(payload.links).toEqual({});
    expect(wire(payload)).not.toContain('"href":"//');
  });
});

test.describe('link redaction (the class site’s old static-render cases, on JSON)', () => {
  test('hidden pageLink and navGrid entries are dropped with their titles; nesting does not hide them', () => {
    const nested = [
      {
        type: 'columnList',
        children: [
          {
            type: 'column',
            children: [
              { type: 'pageLink', props: { pageId: 'hidden', pageTitle: 'Exam 2 Solutions' } },
            ],
          },
          {
            type: 'column',
            children: [
              {
                type: 'navGrid',
                props: {
                  entries: navEntries([
                    { kind: 'page', pageId: 'hidden', title: 'Exam 2 Solutions' },
                    { kind: 'page', pageId: 'shown', title: 'Week 1' },
                  ]),
                },
              },
            ],
          },
        ],
      },
    ];
    const resolve = (id: string) => (id === 'shown' ? { href: '/w1', title: 'Week 1' } : null);
    const out = JSON.stringify(redactDocumentForViewer(nested, resolve));
    expect(out).not.toContain('Exam 2 Solutions');
    expect(out).not.toContain('hidden');
    expect(out).toContain('Week 1');
  });

  test('without dropSchedule (a site that serves /schedule) the schedule entry stays', () => {
    const grid = [{ type: 'navGrid', props: { entries: navEntries([{ kind: 'schedule' }]) } }];
    expect(JSON.stringify(redactDocumentForViewer(grid, () => null))).toContain('schedule');
    expect(
      JSON.stringify(redactDocumentForViewer(grid, () => null, { dropSchedule: true }))
    ).not.toContain('schedule');
  });
});

test.describe('the app link rule (appLinkPolicy)', () => {
  const policy = appLinkPolicy('cs x');
  const row = (over: Partial<LinkedPageRow>): LinkedPageRow => ({
    id: 'p',
    classroom_id: X,
    title: 't',
    slug: 's',
    is_public: true,
    is_draft: false,
    ...over,
  });

  test('mirrors the page route’s own gates', () => {
    expect(policy.canOpen(row({}), null)).toBe(true);
    expect(policy.canOpen(row({ is_public: false }), null)).toBe(false);
    expect(policy.canOpen(row({ is_draft: true }), null)).toBe(false);
    const student = viewer('s', STUDENT);
    expect(policy.canOpen(row({ is_public: false }), student)).toBe(true);
    expect(policy.canOpen(row({ is_draft: true }), student)).toBe(false);
    const ta = viewer('ta', access({ role: 'ASSISTANT', acceptedRole: null, canViewDrafts: true }));
    expect(policy.canOpen(row({ is_draft: true, is_public: false }), ta)).toBe(true);
    expect(policy.href(row({ id: 'a/b' }))).toBe('/cs%20x/a%2Fb');
  });
});

test.describe('link rendering decisions (pure)', () => {
  const links = {
    a: { href: '/c/a', title: 'Live A', membersOnly: false },
    m: { href: '/c/m', title: 'Members', membersOnly: true },
  };

  test('pageLink: a real link with the live title, nothing outside the map, legacy without a map', () => {
    expect(pageLinkRender(links, 'a', 'Stored')).toEqual({
      kind: 'link',
      href: '/c/a',
      title: 'Live A',
      pageId: 'a',
    });
    expect(pageLinkRender(links, 'gone', 'Stored')).toEqual({ kind: 'nothing' });
    expect(pageLinkRender(links, '', 'Stored')).toEqual({ kind: 'nothing' });
    expect(pageLinkRender(null, 'a', 'Stored')).toEqual({ kind: 'legacy' });
  });

  test('navGrid: map pages only, authored label first, Members badge, schedule only with a target', () => {
    const labels = {
      label: (entry: { kind: string; label?: string }) =>
        entry.label || (entry.kind === 'schedule' ? 'Schedule' : ''),
      emoji: (entry: { kind: string; emoji?: string }) =>
        entry.emoji || (entry.kind === 'schedule' ? '📅' : ''),
    };
    const entries = [
      { kind: 'page' as const, pageId: 'a', title: '' },
      { kind: 'page' as const, pageId: 'm', title: 'Authored', emoji: '🔒' },
      { kind: 'page' as const, pageId: 'gone', title: 'Gone' },
      { kind: 'schedule' as const },
      { kind: 'external' as const, url: 'https://e.test', label: 'E' },
    ];
    const none = navGridTiles(entries, links, null, labels);
    expect(none.map(tile => tile.kind)).toEqual(['page', 'page', 'external']);
    expect(none[0]).toMatchObject({ href: '/c/a', label: 'Live A', emoji: '', membersOnly: false });
    expect(none[1]).toMatchObject({ label: 'Authored', emoji: '🔒', membersOnly: true });
    const site = navGridTiles(entries, links, '/schedule', labels);
    expect(site.find(tile => tile.kind === 'schedule')).toMatchObject({
      href: '/schedule',
      external: false,
    });
    const app = navGridTiles(entries, links, 'https://cs.site.test/schedule', labels);
    expect(app.find(tile => tile.kind === 'schedule')).toMatchObject({ external: true });
  });

  test('description: shipped text only, the site’s length rules', () => {
    expect(describeBlocks([{ type: 'paragraph', content: text('short') }])).toBeNull();
    const long = describeBlocks([{ type: 'paragraph', content: text('x'.repeat(300)) }]);
    expect(long?.length).toBe(180);
    expect(long?.endsWith('...')).toBe(true);
    expect(
      describeBlocks([
        { type: 'heading', content: text('Intro') },
        { type: 'paragraph', content: text('Public text everyone reads.') },
      ])
    ).toBe('Intro Public text everyone reads.');
  });
});
