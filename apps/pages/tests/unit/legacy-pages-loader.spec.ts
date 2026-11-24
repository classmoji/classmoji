/**
 * Who gets which legacy-page notice, from the REAL page loader and the REAL
 * class-site page loader, with only their I/O swapped for fakes
 * (`importWithStubs`): the database and services, git reads, the collab
 * server. The pure rules (`utils/legacyPage.ts`, the reader rules in
 * `pageSections.server.ts`, the live gates) run as they do in production.
 *
 * A legacy page here: git holds `index.html` and no `content.json`. In a live
 * classroom collab still seeds the room from that HTML, so the room's
 * snapshot answers with converted blocks.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { importWithStubs, routerArgs, stubModule } from '../helpers/dataRequest.helpers.ts';

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

interface Fakes {
  userId: string | null;
  role: Role | null;
  collabEnabled: boolean;
  isPublic: boolean;
  /** What git holds for the page. */
  gitFormat: 'html' | 'json';
  /** The live room's snapshot, or an error. */
  snapshot: 'converted' | 'fails';
  /** What the asset-map/git probe answers, and how often it was asked. */
  probe: boolean;
  probeCalls: number;
  gitReads: number;
  writes: number;
}

const fakes: Fakes = {
  userId: null,
  role: null,
  collabEnabled: true,
  isPublic: true,
  gitFormat: 'html',
  snapshot: 'converted',
  probe: true,
  probeCalls: 0,
  gitReads: 0,
  writes: 0,
};
(globalThis as unknown as { __legacyFakes: Fakes }).__legacyFakes = fakes;

const CONVERTED = [{ id: 'b1', type: 'paragraph', content: [{ type: 'text', text: 'Old body' }] }];
(globalThis as unknown as { __legacyConverted: unknown }).__legacyConverted = CONVERTED;

const F = 'const f = () => globalThis.__legacyFakes;';

const STUBS = {
  '/app/utils/db.server.ts': stubModule(`${F}
const teaching = ['OWNER', 'TEACHER', 'ASSISTANT'];
export const getAuthSession = async () => (f().userId ? { userId: f().userId, userLogin: 'u' } : null);
export const ClassmojiService = {
  page: {
    findById: async () => ({
      id: 'page-1', title: 'Week 1', slug: 'week-1', width: 2, is_draft: false,
      is_public: f().isPublic, content_path: 'pages/week-1', classroom_id: 'class-1',
      header_image_url: null, header_image_position: null,
      classroom: { id: 'class-1', slug: 'cs1', name: 'CS1', status: 'ACTIVE',
        collab_enabled: f().collabEnabled, content_repo: 'content-cs1',
        git_organization: { provider: 'GITHUB', login: 'org' } },
    }),
  },
  pageSections: {
    sectionViewer: async () => {
      const role = f().role;
      const editor = role === 'OWNER' || role === 'TEACHER';
      return { role, acceptedRole: null, teachingTeam: teaching.includes(role),
        student: role === 'STUDENT', canEditAnyState: editor, revealAll: teaching.includes(role),
        canUnlock: role === 'STUDENT', canSeeActivity: false, canViewDrafts: teaching.includes(role) };
    },
    readerState: async () => null,
  },
  pageContent: {
    getPreviewStatus: async () => ({ exists: false }),
    previewBranchName: path => 'preview/' + path,
  },
  contentDelivery: { tierFor: () => 'week' },
  media: { uploadCapabilityFor: async () => null },
};
`),
  '@classmoji/services': stubModule('export const uploadRefusalStatus = () => null;'),
  '/app/utils/auth.server.ts': stubModule('export const pageMutationBlocked = () => null;'),
  '/app/utils/classroomRole.server.ts': stubModule(
    'export const findClassroomRole = async () => globalThis.__legacyFakes.role;'
  ),
  '/app/utils/content.server.ts': stubModule(`${F}
export const loadPageContent = async () => {
  f().gitReads += 1;
  return f().gitFormat === 'html'
    ? { format: 'html', content: '<p>Old body</p>', coverImage: null, sha: 'html-sha' }
    : { format: 'json', content: globalThis.__legacyConverted, coverImage: null, sha: 'json-sha' };
};
export const savePageContent = async () => { f().writes += 1; return { sha: 'x', commit: 'y' }; };
export const savePageCoverImage = async () => { throw new Error('no writes here'); };
export const uploadPageAsset = async () => { throw new Error('no writes here'); };
`),
  '/app/utils/legacyPage.server.ts': stubModule(`${F}
export const pageIsLegacyInGit = async () => { f().probeCalls += 1; return f().probe; };
`),
  '/app/utils/mediaDownloads.server.ts': stubModule(
    'export const loadMediaDownloads = async () => ({});'
  ),
  '/app/utils/pageComments.server.ts': stubModule(
    'export const readerCommentsFor = () => undefined;'
  ),
  '/app/utils/assetRefs.server.ts': stubModule(`
export const assetResolveContext = () => null;
export const resolveDocumentAssets = async () => ({ assets: {}, srcSets: {} });
export const canonicalizeAssetRef = async x => x;
export const canonicalizeDocumentAssets = async x => x;
export const canonicalizeOpsAssets = async x => x;
`),
  '/app/utils/collab.server.ts': stubModule(`${F}
export const liveEditingEnv = classroom => (classroom.collab_enabled ? { httpUrl: 'http://collab', wsUrl: 'ws://collab', secret: 's' } : null);
export const collabEditorData = async () => ({ room: 'page:page-1:1', token: 't' });
export const fetchLiveSnapshot = async () => {
  if (f().snapshot === 'fails') throw new Error('timeout');
  return { epoch: 1, version: 3, live: false, content: { blocks: globalThis.__legacyConverted, coverImage: null } };
};
export const readPageBookkeeping = async () => null;
export const liveEditingBlockedFor = async () => false;
export const notifyPageMeta = async () => {};
export const notifyPreviewChanged = async () => {};
export const readEditorName = async () => 'u';
export const requestCheckpoint = async () => ({});
`),
  '/app/utils/readerDeps.server.ts': stubModule(`
export const readerPayloadDeps = {
  assetContext: () => null,
  resolveAssets: async () => ({ assets: {}, srcSets: {} }),
  loadMediaDownloads: async () => ({}),
  linkedPages: async () => [],
  readerComments: async () => undefined,
};
export const appScheduleHref = async () => null;
`),
  '/app/utils/collabPreview.server.ts': stubModule(`
export const acceptPreviewLive = async () => ({});
export const normalizePageBlocks = x => x;
export const previewBaseContent = async () => null;
`),
  '/app/utils/saveOps.server.ts': stubModule(
    'export const OPS_MALFORMED_ANSWER = {}; export const readCanonicalSaveOps = async () => null;'
  ),
};

interface LoaderData {
  /** The document the page shows: the reader's on a read-only path, else the editors'. */
  content: unknown;
  reader?: { content: unknown } | null;
  /** Which document shipped: the reader payload's, or the editors' `content`. */
  shipped: 'reader' | 'editor';
  /** The top-level (editors') `content` exactly as the loader sent it. */
  editorContent: unknown;
  collab: unknown;
  canEdit: boolean;
  legacyNotice: 'live' | 'unshown' | null;
  legacyReadOnly: boolean;
}

let loader: (args: unknown) => Promise<LoaderData>;
let action: (args: unknown) => Promise<Response>;

test.beforeAll(async () => {
  ({ loader, action } = await importWithStubs<{ loader: typeof loader; action: typeof action }>(
    new URL('../../app/routes/$classroomSlug.$pageId/route.server.ts?legacy', import.meta.url),
    STUBS
  ));
});

const EMPTY = [{ type: 'paragraph', content: [] }];

async function view(over: Partial<Fakes>): Promise<LoaderData> {
  Object.assign(fakes, {
    userId: null,
    role: null,
    collabEnabled: true,
    isPublic: true,
    gitFormat: 'html',
    snapshot: 'converted',
    probe: true,
    probeCalls: 0,
    gitReads: 0,
    writes: 0,
    ...over,
  });
  const data = await loader({
    ...routerArgs('http://localhost:6100/cs1/page-1'),
    params: { classroomSlug: 'cs1', pageId: 'page-1' },
  });
  // A read-only path ships its document in the reader payload, an editor in `content`.
  return {
    ...data,
    content: data.reader ? data.reader.content : data.content,
    shipped: data.reader ? 'reader' : 'editor',
    editorContent: data.content,
  };
}

test.describe('in-app page loader, a page git holds as legacy HTML', () => {
  test('owner in a live classroom, snapshot answers: the live editor as before, with the live notice', async () => {
    const data = await view({ userId: 'owner', role: 'OWNER' });
    expect(data.collab).not.toBeNull();
    expect(data.content).toEqual(CONVERTED);
    expect(data.canEdit).toBe(true);
    expect(data.legacyNotice).toBe('live');
    expect(data.legacyReadOnly).toBe(false);
    // Decided from git/the map, not from the snapshot's 'json'.
    expect(fakes.probeCalls).toBe(1);
    expect(fakes.gitReads).toBe(0);
  });

  test('owner in a live classroom, snapshot fails: as for any failed snapshot, the empty document and the notice', async () => {
    const data = await view({ userId: 'owner', role: 'OWNER', snapshot: 'fails' });
    expect(data.collab).not.toBeNull();
    expect(data.content).toEqual(EMPTY);
    expect(data.legacyNotice).toBe('live');
    // Never gated where there is live editing.
    expect(data.legacyReadOnly).toBe(false);
    expect(fakes.probeCalls).toBe(0);
  });

  test('owner in a classroom without live editing: empty, "can\'t be shown", no git editor', async () => {
    const data = await view({ userId: 'owner', role: 'OWNER', collabEnabled: false });
    expect(data.collab).toBeNull();
    expect(data.content).toEqual(EMPTY);
    expect(data.legacyNotice).toBe('unshown');
    expect(data.legacyReadOnly).toBe(true);
  });

  test('assistant: empty with "can\'t be shown"', async () => {
    const data = await view({ userId: 'ta', role: 'ASSISTANT' });
    expect(data.collab).toBeNull();
    expect(data.content).toEqual(EMPTY);
    expect(data.legacyNotice).toBe('unshown');
    expect(data.legacyReadOnly).toBe(false);
  });

  test('student: empty, no notice', async () => {
    const data = await view({ userId: 'stu', role: 'STUDENT' });
    expect(data.content).toEqual(EMPTY);
    expect(data.legacyNotice).toBeNull();
    expect(fakes.probeCalls).toBe(0);
  });

  test('anonymous visitor on a public page: empty, no notice', async () => {
    const data = await view({});
    expect(data.content).toEqual(EMPTY);
    expect(data.legacyNotice).toBeNull();
    expect(data.legacyReadOnly).toBe(false);
  });

  test('a page with content.json: no notice for anyone, even in the live editor', async () => {
    const live = await view({ userId: 'owner', role: 'OWNER', gitFormat: 'json', probe: false });
    expect(live.legacyNotice).toBeNull();
    const ta = await view({ userId: 'ta', role: 'ASSISTANT', gitFormat: 'json' });
    expect(ta.legacyNotice).toBeNull();
    expect(ta.content).toEqual(CONVERTED);
  });
});

test.describe('in-app page loader: the reader and the editors never share a document', () => {
  // The reader's document is link-redacted (a dropped link would be deleted by
  // a save), so it must never be the one an editor mounts.
  test('editors get `content` and no reader payload', async () => {
    for (const over of [
      { userId: 'owner', role: 'OWNER' as const, gitFormat: 'json' as const },
      { userId: 'owner', role: 'OWNER' as const, gitFormat: 'json' as const, collabEnabled: false },
    ]) {
      const data = await view(over);
      expect(data.shipped).toBe('editor');
      expect(data.reader).toBeNull();
      expect(data.editorContent).toEqual(CONVERTED);
    }
  });

  test('every read-only path gets the reader payload and no editor document', async () => {
    for (const over of [
      { userId: 'stu', role: 'STUDENT' as const, gitFormat: 'json' as const },
      { gitFormat: 'json' as const },
      { userId: 'ta', role: 'ASSISTANT' as const, gitFormat: 'json' as const },
      // A legacy page with no live editing: the owner reads it.
      { userId: 'owner', role: 'OWNER' as const, collabEnabled: false },
    ]) {
      const data = await view(over);
      expect(data.shipped, JSON.stringify(over)).toBe('reader');
      expect(data.editorContent, JSON.stringify(over)).toBeNull();
    }
  });

  test('the route re-seeds its editor when the reader gives way to an editor on the same page', () => {
    const route = readFileSync(
      fileURLToPath(new URL('../../app/routes/$classroomSlug.$pageId/route.tsx', import.meta.url)),
      'utf8'
    );
    expect(route).toContain(
      'if (lastPageIdRef.current !== page.id || lastShownReaderRef.current !== Boolean(reader)) {'
    );
    const reset = route.slice(route.indexOf('lastShownReaderRef.current = Boolean(reader);'));
    expect(reset.slice(0, 400)).toContain('setEditorDoc(content);');
    expect(reset.slice(0, 400)).toContain('setContentToken(contentSha);');
  });
});

test.describe('in-app page action, a page git holds as legacy HTML', () => {
  test('a git-editor save (no live editing) is refused with 422 and writes nothing', async () => {
    Object.assign(fakes, {
      userId: 'owner',
      role: 'OWNER',
      collabEnabled: false,
      gitFormat: 'html',
      writes: 0,
    });
    const response = await action({
      params: { classroomSlug: 'cs1', pageId: 'page-1' },
      request: new Request('http://localhost:6100/cs1/page-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent: 'save', content: JSON.stringify(EMPTY) }),
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "This page is in an old format and can't be changed here. The Classmoji team can convert it.",
    });
    expect(fakes.writes).toBe(0);
  });
});

// ─── The class site ──────────────────────────────────────────────────────────

const SITE_STUBS = (role: Role | null) => ({
  './tenant.server.ts': stubModule(`
const STAFF = new Set(['OWNER', 'TEACHER']);
export const resolveSiteContext = async () => ({
  site: { classroom_id: 'class-1', home_page_id: null, classroom: { name: 'CS1', slug: 'cs1' } },
  viewer: { userId: ${role ? "'u'" : 'null'}, role: ${role ? `'${role}'` : 'null'}, login: 'u', name: 'U' },
  memberLinkOrigin: '', seoOrigin: null,
});
export const isStaff = viewer => viewer.role !== null && STAFF.has(viewer.role);
export const isMember = viewer => viewer.role !== null;
export const publicPathOf = pathname => pathname;
`),
  './pageRender.server.ts': stubModule(`
export const loadSitePageView = async () => ({ title: 'Week 1', coverImage: null, description: null, legacyFormat: true, island: { payload: { content: [], assets: {}, srcSets: {} } }, assets: {} });
export const siteReaderPolicy = () => ({ assetsOrigin: null, connect: true });
`),
  './headers.server.ts': stubModule(
    'export const siteHeaders = () => ({}); export const routeSiteHeaders = () => new Headers();'
  ),
  './env.server.ts': stubModule("export const pagesUrl = () => 'http://pages';"),
  '/app/utils/db.server.ts': stubModule(`
export const ClassmojiService = { site: {
  getPageBySlugForSite: async () => ({ id: 'page-1', title: 'Week 1', slug: 'week-1', content_path: 'pages/week-1', is_public: true, is_draft: false }),
  isPageVisibleOnSite: () => true,
} };
`),
});

async function siteView(role: Role | null): Promise<{ legacyNotice: boolean }> {
  const { loader: siteLoader } = await importWithStubs<{
    loader: (args: unknown) => Promise<{ data: { legacyNotice: boolean } }>;
  }>(
    new URL(`../../app/site/page.tsx?legacy-${role ?? 'anon'}`, import.meta.url),
    SITE_STUBS(role)
  );
  const result = await siteLoader({
    ...routerArgs('http://cs1.classmoji.test/week-1'),
    params: { subdomain: 'cs1', pageSlug: 'week-1' },
  });
  return result.data;
}

test.describe('class site, a page git holds as legacy HTML', () => {
  test('staff get the notice; members who are not staff and anonymous visitors do not', async () => {
    expect((await siteView('OWNER')).legacyNotice).toBe(true);
    expect((await siteView('TEACHER')).legacyNotice).toBe(true);
    expect((await siteView('STUDENT')).legacyNotice).toBe(false);
    expect((await siteView(null)).legacyNotice).toBe(false);
  });
});
