/**
 * The class site on the reader island: the REAL site routes (`site/page.tsx`,
 * `site/home.tsx`, `GET /api/page-reader`, `/api/page-sections` and
 * `/api/page-comments` on a site host), the REAL tenant resolver, the REAL
 * site composition (`site/pageRender.server.ts`) and the REAL payload builder
 * and headers, with only their I/O swapped for fakes (`importTreeWithStubs`):
 * the database, the session, the git read, asset signing, the island's build
 * assets.
 *
 * Who gets what:
 *   - NON-MEMBERS (anonymous, a signed-in stranger, a member of ANOTHER
 *     classroom, everyone on a custom domain): one payload — locked bodies
 *     out, no members-only page anywhere, no tick boxes, comments or
 *     downloads, the site's sign-in link — byte for byte, except that a
 *     signed-in one is marked signed in (their locked sections say only
 *     members can unlock them).
 *   - PENDING MEMBERS (enrolled, invite not accepted): the non-member reader
 *     plus the site's members-only pages and their links, as in the app;
 *     nothing else, whatever role the pending row names.
 *   - MEMBERS: their own reader (their unlocks, ticks, comments, downloads).
 *   - STAFF (accepted owner/teacher/assistant): every locked body; the Edit
 *     pill for owners and teachers.
 *   - A member's payload is never in a cacheable response.
 */
import { test, expect } from '@playwright/test';

import { importTreeWithStubs, routerArgs, stubModule } from '../helpers/dataRequest.helpers.ts';
import { siteRouterContext } from '../../server/loadContext.ts';
import { serializeIslandData, type ReaderIslandData } from '../../app/reader-island/contract.ts';
import { DARK_MODE_SCRIPT_HASH } from '../../app/site/headers.server.ts';
import { fetchSiteReaderPayload, hostOptionsFor } from '../../app/reader-island/hostOptions.ts';
import { ownFrameHosts } from '../../app/utils/frameHosts.server.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const X = 'class-x';
const Y = 'class-y';

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';
const MEMBERSHIPS: Array<{ user: string; classroom: string; role: Role; accepted: boolean }> = [
  { user: 'student-x', classroom: X, role: 'STUDENT', accepted: true },
  { user: 'owner-x', classroom: X, role: 'OWNER', accepted: true },
  { user: 'ta-x', classroom: X, role: 'ASSISTANT', accepted: true },
  { user: 'pending-x', classroom: X, role: 'TEACHER', accepted: false },
  { user: 'student-y', classroom: Y, role: 'STUDENT', accepted: true },
  // Pending in Y only: a stranger on X's site.
  { user: 'pending-y', classroom: Y, role: 'STUDENT', accepted: false },
  // A pending OWNER row in X (and nothing accepted).
  { user: 'pending-owner', classroom: X, role: 'OWNER', accepted: false },
  // An accepted student holding a PENDING teacher invite.
  { user: 'dual', classroom: X, role: 'STUDENT', accepted: true },
  { user: 'dual', classroom: X, role: 'TEACHER', accepted: false },
  // In both classrooms: only the host decides which pages a call may name.
  { user: 'both', classroom: X, role: 'STUDENT', accepted: true },
  { user: 'both', classroom: Y, role: 'STUDENT', accepted: true },
];

const SECRET = 'SECRET LOCKED BODY';
const p = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  props: {},
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});
const BLOCKS = [
  p('intro', 'Welcome to the course, this is the public introduction everyone reads.'),
  {
    id: 'img-top',
    type: 'image',
    props: { url: 'media://img-top', previewWidth: 480 },
    children: [],
  },
  {
    id: 'h-check',
    type: 'heading',
    props: { level: 2, checkable: true },
    content: [{ type: 'text', text: 'Setup', styles: {} }],
    children: [],
  },
  {
    id: 'item',
    type: 'checkListItem',
    props: { personal: true, checked: false },
    content: [{ type: 'text', text: 'Install the tools', styles: {} }],
    children: [],
  },
  {
    id: 'lock',
    type: 'lockedSection',
    props: { title: 'Solution' },
    content: [],
    children: [
      p('lock-body', SECRET),
      { id: 'img-lock', type: 'image', props: { url: 'media://img-lock' }, children: [] },
    ],
  },
  p('escape', 'Escaping: </script><!--<script>window.__pwned = 1</script> stays text.'),
  { id: 'l-pub', type: 'pageLink', props: { pageId: 'p-pub2', pageTitle: 'Stored' }, children: [] },
  {
    id: 'l-mem',
    type: 'pageLink',
    props: { pageId: 'p-mem', pageTitle: 'Members Lab stored' },
    children: [],
  },
  {
    id: 'grid',
    type: 'navGrid',
    props: {
      entries: JSON.stringify([
        { kind: 'page', pageId: 'p-pub2', title: '' },
        { kind: 'page', pageId: 'p-mem', title: '' },
        { kind: 'page', pageId: 'p-y', title: '' },
        { kind: 'schedule' },
      ]),
    },
    children: [],
  },
  { id: 'file', type: 'file', props: { url: 'media://m1', name: 'handout.pdf' }, children: [] },
];

const PAGES = [
  { id: 'p-home', classroom_id: X, title: 'Home', slug: 'home', is_public: true, is_draft: false },
  {
    id: 'p-pub',
    classroom_id: X,
    title: 'Week 1',
    slug: 'week-1',
    is_public: true,
    is_draft: false,
  },
  {
    id: 'p-pub2',
    classroom_id: X,
    title: 'Week 2',
    slug: 'week-2',
    is_public: true,
    is_draft: false,
  },
  {
    id: 'p-mem',
    classroom_id: X,
    title: 'Members Lab',
    slug: 'members-lab',
    is_public: false,
    is_draft: false,
  },
  {
    id: 'p-draft',
    classroom_id: X,
    title: 'Draft',
    slug: 'draft',
    is_public: true,
    is_draft: true,
  },
  { id: 'p-y', classroom_id: Y, title: 'Y page', slug: 'y-page', is_public: true, is_draft: false },
].map(page => ({
  ...page,
  content_path: `pages/${page.slug}`,
  width: 2,
  header_image_url: null,
  header_image_position: null,
}));

const classroom = (id: string, slug: string) => ({
  id,
  slug,
  name: slug.toUpperCase(),
  status: 'ACTIVE',
  is_archived: false,
  content_repo: 'content',
  content_key_version: 0,
  content_delivery_enabled: true,
  git_organization: { id: 'org', login: 'org', provider: 'GITHUB' },
  settings: null,
});
const SITES = {
  cs52: {
    id: 'site-x',
    subdomain: 'cs52',
    classroom_id: X,
    home_page_id: 'p-home',
    show_schedule: true,
    is_enabled: true,
    classroom: classroom(X, 'cs52'),
  },
  cs53: {
    id: 'site-y',
    subdomain: 'cs53',
    classroom_id: Y,
    home_page_id: null,
    show_schedule: false,
    is_enabled: true,
    classroom: classroom(Y, 'cs53'),
  },
};

interface Fakes {
  auditThrows: boolean;
  scheduleRoles: Array<string | null>;
  sessionReads: number;
  contentFails: boolean;
  unlocked: Record<string, Record<string, string>>;
  audits: Array<Record<string, unknown>>;
  downloadsAsked: string[];
  sectionWrites: string[];
  commentViewers: boolean[];
}
const fakes: Fakes = {
  auditThrows: false,
  scheduleRoles: [],
  sessionReads: 0,
  contentFails: false,
  unlocked: {},
  audits: [],
  downloadsAsked: [],
  sectionWrites: [],
  commentViewers: [],
};
Object.assign(globalThis, {
  __siteFakes: fakes,
  __siteData: { MEMBERSHIPS, PAGES, SITES, BLOCKS },
});

const F = 'const f = () => globalThis.__siteFakes; const d = () => globalThis.__siteData;';

// One module (one URL), so `instanceof` in the route sees the class the fake throws.
const CONTENT_STUB = stubModule(`${F}
export class SiteContentUnavailableError extends Error { constructor(m, s) { super(m); this.status = s ?? null; } }
export const loadSitePageContent = async page => {
  if (f().contentFails) throw new SiteContentUnavailableError('down', 502);
  return { format: 'json', blocks: d().BLOCKS, coverImage: null };
};
`);

const highest = `const RANK = { OWNER: 4, TEACHER: 3, ASSISTANT: 2, STUDENT: 1 };`;

const STUBS: Record<string, string> = {
  '/app/utils/db.server.ts': stubModule(`${F} ${highest}
const TEAM = ['OWNER', 'TEACHER', 'ASSISTANT'];
// "Cookie" sessions: classmoji.session_token=<user> (or imp-<user> for View as);
// an x-test-user header is a session with no recognizable cookie.
export const getAuthSession = async request => {
  f().sessionReads += 1;
  const cookie = request.headers.get('cookie') || '';
  const m = /classmoji\\.session_token=([\\w-]+)/.exec(cookie);
  const token = m ? m[1] : request.headers.get('x-test-user');
  if (!token) return null;
  const imp = token.startsWith('imp-');
  const userId = imp ? token.slice(4) : token;
  return { userId, userLogin: userId, session: { session: imp ? { impersonatedBy: 'admin-1' } : {} } };
};
const pageOf = where => d().PAGES.find(p => p.id === where.id && (!where.classroom_id || p.classroom_id === where.classroom_id)) ?? null;
export const prisma = {
  user: { findUnique: async ({ where }) => ({ id: where.id, name: 'Name ' + where.id, image: null, accounts: [] }) },
  classroomMembership: {
    findMany: async ({ where }) => d().MEMBERSHIPS
      .filter(m => m.classroom === where.classroom_id && m.user === where.user_id && (where.has_accepted_invite === undefined || m.accepted === where.has_accepted_invite))
      .map(m => ({ role: m.role, has_accepted_invite: m.accepted })),
  },
  page: {
    findFirst: async ({ where }) => pageOf(where),
    findMany: async ({ where }) => d().PAGES.filter(p => p.classroom_id === where.classroom_id && (where.is_draft === undefined || p.is_draft === where.is_draft)),
  },
};
const visible = (page, role) => !page.is_draft && (page.is_public || role !== null);
export const ClassmojiService = {
  site: {
    getSiteBySubdomain: async sub => d().SITES[sub] ? { state: 'active', site: d().SITES[sub] } : { state: 'not_found' },
    getSiteByCustomDomain: async host => host === 'course.example.edu'
      ? { state: 'active', site: { id: 'site-x', subdomain: 'cs52' }, verifiedAt: new Date() }
      : { state: 'not_found' },
    markCustomDomainVerified: async () => {},
    getPageBySlugForSite: async (classroomId, slug) => d().PAGES.find(p => p.classroom_id === classroomId && (p.slug === slug || p.id === slug)) ?? null,
    getHomePageForViewer: async (site, role) => {
      const page = d().PAGES.find(p => p.id === site.home_page_id && p.classroom_id === site.classroom_id);
      return page && visible(page, role) ? page : null;
    },
    isPageVisibleOnSite: visible,
    listPublicModulesForViewer: async (classroomId, role) => { f().scheduleRoles.push(role); return []; },
  },
  classroom: { getTimeZone: async () => null },
  pageSections: {
    sectionViewerFromMemberships: rows => {
      const best = list => list.reduce((a, r) => (a === null || RANK[r] > RANK[a] ? r : a), null);
      const role = best(rows.map(r => r.role));
      const acceptedRole = best(rows.filter(r => r.has_accepted_invite).map(r => r.role));
      const teachingTeam = acceptedRole !== null && TEAM.includes(acceptedRole);
      const student = acceptedRole === 'STUDENT';
      const canEditAnyState = role === 'OWNER' || role === 'TEACHER';
      const revealAll = canEditAnyState || teachingTeam;
      return { role, acceptedRole, teachingTeam, student, canEditAnyState, revealAll,
        canUnlock: student && !revealAll, canSeeActivity: acceptedRole === 'OWNER' || acceptedRole === 'TEACHER',
        canViewDrafts: role !== null && TEAM.includes(role) };
    },
    readerState: async ({ pageId, userId }) => ({ checked: [], unlocked: f().unlocked[userId + ':' + pageId] ?? {} }),
    sectionViewer: async ({ userId, classroomId }) => {
      const rows = d().MEMBERSHIPS.filter(m => m.user === userId && m.classroom === classroomId)
        .map(m => ({ role: m.role, has_accepted_invite: m.accepted }));
      return ClassmojiService.pageSections.sectionViewerFromMemberships(rows);
    },
    setChecked: async ({ blockId, checked }) => { f().sectionWrites.push('check:' + blockId); return { checked, changed: true }; },
    recordUnlock: async ({ blockId }) => { f().sectionWrites.push('unlock:' + blockId); return { unlockedAt: new Date(0), created: true }; },
    sectionActivity: async () => ({ students: 1, unlocks: [], checks: [] }),
    unlockCounts: async () => ({ students: 1, unlocks: {} }),
    checkCounts: async () => ({ students: 1, checks: {} }),
    PageSectionsValidationError: class extends Error {},
  },
  pageComments: {
    commentAccess: ({ viewer }) => {
      f().commentViewers.push(viewer.revealAll);
      return { canRead: true, canWrite: true, canResolve: false, canModerate: false, frozen: false, role: viewer.acceptedRole };
    },
    commentContext: args => ({ ...args, access: { canRead: true, canWrite: true, canResolve: false, canModerate: false, frozen: false, role: args.viewer.acceptedRole } }),
    listThreads: async () => [],
  },
  page: {
    findById: async id => {
      const page = d().PAGES.find(p => p.id === id);
      const site = Object.values(d().SITES).find(s => s.classroom_id === page?.classroom_id);
      return page ? { ...page, classroom: { ...(site?.classroom ?? {}), id: page.classroom_id, status: 'ACTIVE' } } : null;
    },
  },
  pageContent: {
    getPreviewStatus: async () => ({ exists: false }),
    previewBranchName: path => 'preview/' + path,
  },
  media: { uploadCapabilityFor: async () => null },
  contentDelivery: {
    tierFor: ({ isPublic }) => (isPublic ? 'month' : 'week'),
    resolveAssetUrl: async (ctx, ref) => ref,
  },
  audit: { create: async row => { if (f().auditThrows) throw new Error('audit down'); f().audits.push(row); return row; } },
};
`),
  '/app/site/content.server.ts': CONTENT_STUB,
  '/app/utils/content.server.ts': stubModule(`${F}
export const loadPageContent = async () => ({ format: 'json', content: d().BLOCKS, coverImage: null, sha: 's' });
export const savePageContent = async () => { throw new Error('no writes here'); };
export const savePageCoverImage = async () => { throw new Error('no writes here'); };
export const uploadPageAsset = async () => { throw new Error('no writes here'); };
`),
  '/app/utils/assetRefs.server.ts': stubModule(`
export const assetResolveContext = () => null;
export const resolveDocumentAssets = async () => ({ assets: {}, srcSets: {} });
export const canonicalizeAssetRef = async x => x;
export const canonicalizeDocumentAssets = async x => x;
export const canonicalizeOpsAssets = async x => x;
`),
  // The pages app's page loader (the "View as" audit on load).
  '/app/utils/legacyPage.server.ts': stubModule(
    'export const pageIsLegacyInGit = async () => false;'
  ),
  '/app/utils/collabPreview.server.ts': stubModule(`
export const acceptPreviewLive = async () => ({});
export const normalizePageBlocks = x => x;
export const previewBaseContent = async () => null;
`),
  '/app/utils/saveOps.server.ts': stubModule(
    'export const OPS_MALFORMED_ANSWER = {}; export const readCanonicalSaveOps = async () => null;'
  ),
  '/app/utils/classroomRole.server.ts': stubModule(
    'export const findClassroomRole = async () => null;'
  ),
  '/app/utils/readerDeps.server.ts': stubModule(`${F}
export const readerPayloadDeps = {
  assetContext: () => ({ ctx: true }),
  resolveAssets: async () => ({
    assets: {
      'media://m1': 'https://content.test/m1.pdf?sig',
      'media://img-top': 'https://content.test/top.png?sig',
      'media://img-lock': 'https://content.test/LOCKED.png?sig',
    },
    srcSets: { 'media://img-top': 'https://content.test/top-480.png 480w, https://content.test/top.png 1024w' },
  }),
  loadMediaDownloads: async (classroomId, blocks, role) => { f().downloadsAsked.push(classroomId + ':' + role); return { 'media://m1': true }; },
  linkedPages: async (classroomId, ids) => d().PAGES.filter(p => p.classroom_id === classroomId && ids.includes(p.id)),
  readerComments: async ({ viewer }) => ({ counts: {}, pageLevel: 0, open: 0, canWrite: viewer.acceptedRole !== null, canResolve: false, frozen: false }),
};
export const appScheduleHref = async () => null;
`),
  '/app/reader-island/assets.server.ts': stubModule(
    "export const readerIslandAssets = { dev: false, entry: '/assets/entry-abc.js', css: ['/assets/reader.css'], preloads: [] };"
  ),
  '/app/utils/collab.server.ts': stubModule(`
export const liveEditingEnv = () => null;
export const fetchLiveSnapshot = async () => null;
export const collabEditorData = async () => null;
export const liveEditingBlockedFor = async () => false;
export const readPageBookkeeping = async () => null;
export const notifyPageMeta = async () => {};
export const notifyPreviewChanged = async () => {};
export const readEditorName = async () => 'u';
export const requestCheckpoint = async () => ({});
`),
  '/app/utils/auth.server.ts': stubModule('export const pageMutationBlocked = () => null;'),
  '@classmoji/services': stubModule(`
export const siteOrigin = sub => 'https://' + sub + '.classmoji.test';
export const siteBaseDomain = () => 'classmoji.test';
export const customDomainOrigin = host => 'https://' + host;
export const canonicalOriginForSite = async site => 'https://' + site.subdomain + '.classmoji.test';
export const seoOriginFor = ({ subdomainOrigin }) => subdomainOrigin;
export const uploadRefusalStatus = () => null;
`),
};

type Loader = (args: unknown) => Promise<{ data: Record<string, unknown>; init?: ResponseInit }>;
type Route = (args: unknown) => Promise<Response>;

let pageLoader: Loader;
let homeLoader: Loader;
let readerRoute: Route;
let sectionsAction: Route;
let commentsAction: Route;
let commentsLoader: Route;
let appPageLoader: (args: unknown) => Promise<Record<string, unknown>>;
let scheduleLoader: Loader;

test.beforeAll(async () => {
  const at = (path: string) => new URL(path, import.meta.url);
  ({ loader: pageLoader } = await importTreeWithStubs<{ loader: Loader }>(
    at('../../app/site/page.tsx'),
    STUBS,
    'site-reader'
  ));
  ({ loader: homeLoader } = await importTreeWithStubs<{ loader: Loader }>(
    at('../../app/site/home.tsx'),
    STUBS,
    'site-reader'
  ));
  ({ loader: readerRoute } = await importTreeWithStubs<{ loader: Route }>(
    at('../../app/routes/api.page-reader/route.ts'),
    STUBS,
    'site-reader'
  ));
  ({ action: sectionsAction } = await importTreeWithStubs<{ action: Route }>(
    at('../../app/routes/api.page-sections/route.ts'),
    STUBS,
    'site-reader'
  ));
  ({ action: commentsAction, loader: commentsLoader } = await importTreeWithStubs<{
    action: Route;
    loader: Route;
  }>(at('../../app/routes/api.page-comments/route.ts'), STUBS, 'site-reader'));
  ({ loader: scheduleLoader } = await importTreeWithStubs<{ loader: Loader }>(
    at('../../app/site/schedule.tsx'),
    STUBS,
    'site-reader'
  ));
  ({ loader: appPageLoader } = await importTreeWithStubs<{ loader: typeof appPageLoader }>(
    at('../../app/routes/$classroomSlug.$pageId/route.server.ts'),
    STUBS,
    'site-reader'
  ));
});

test.beforeEach(() => {
  Object.assign(fakes, {
    auditThrows: false,
    scheduleRoles: [],
    sessionReads: 0,
    contentFails: false,
    unlocked: {},
    audits: [],
    downloadsAsked: [],
    sectionWrites: [],
    commentViewers: [],
  });
});

const HOST = 'http://cs52.classmoji.test';

/** Headers for a visitor: a session cookie for `who`, none for null. */
const visitor = (who: string | null, extra: Record<string, string> = {}) =>
  who ? { cookie: `theme=dark; classmoji.session_token=${who}`, ...extra } : extra;

interface SiteResult {
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
  island: ReaderIslandData;
}

async function sitePage(
  slug: string,
  who: string | null,
  {
    customDomain = null,
    extraHeaders = {},
    method = 'GET',
  }: { customDomain?: string | null; extraHeaders?: Record<string, string>; method?: string } = {}
): Promise<SiteResult> {
  const result = await pageLoader({
    ...routerArgs(`${HOST}/_site/cs52/${slug}`, { method, headers: visitor(who, extraHeaders) }),
    params: { subdomain: 'cs52', pageSlug: slug },
    context: siteRouterContext({ customDomain, siteSubdomain: null }),
  });
  return {
    status: (result.init?.status as number | undefined) ?? 200,
    data: result.data,
    headers: new Headers(result.init?.headers),
    island: result.data.island as ReaderIslandData,
  };
}

async function thrown(run: () => Promise<unknown>): Promise<Response> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error('expected a thrown Response');
}

const json = (island: ReaderIslandData) => serializeIslandData(island);

// ─── The site page ──────────────────────────────────────────────────────────

/** The island data with `readerSections.signedIn` set back to false. */
const asSignedOut = (island: ReaderIslandData): ReaderIslandData => ({
  ...island,
  payload: {
    ...island.payload,
    readerSections: { ...island.payload.readerSections, signedIn: false },
  },
});

test.describe('non-members: one public payload', () => {
  test('a signed-in stranger and a member (or pending member) of another classroom get the anonymous island data, marked signed in', async () => {
    const anonymous = await sitePage('week-1', null);
    expect(anonymous.island.payload.readerSections).toMatchObject({
      signedIn: false,
      member: false,
    });
    for (const who of ['stranger', 'student-y', 'pending-y']) {
      const other = await sitePage('week-1', who);
      // The one difference: signed in, not a member (no sign-in link loop).
      expect(other.island.payload.readerSections, who).toMatchObject({
        signedIn: true,
        member: false,
      });
      expect(json(asSignedOut(other.island)), who).toBe(json(anonymous.island));
      // Signed in: never in a shared cache.
      expect(other.headers.get('Cache-Control'), who).toBe('private, no-store');
    }
    expect(anonymous.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  test('a pending member differs from anonymous exactly in the members-only links (and signed in, no sign-in link)', async () => {
    const anonymous = (await sitePage('week-1', null)).island.payload;
    const pending = await sitePage('week-1', 'pending-x');
    const payload = pending.island.payload;
    expect(pending.headers.get('Cache-Control')).toBe('private, no-store');
    // The members-only page is a link for them, marked members-only.
    expect(payload.links).toEqual({
      ...anonymous.links,
      'p-mem': { href: '/members-lab', title: 'Members Lab', membersOnly: true },
    });
    // The blocks naming it stay: its page link, and its entry in the directory.
    const ids = (content: unknown[]) => (content as Array<{ id: string }>).map(b => b.id);
    expect(ids(payload.content)).toEqual(
      ids(anonymous.content).flatMap(id => (id === 'l-pub' ? [id, 'l-mem'] : [id]))
    );
    const grid = (content: unknown[]) =>
      JSON.parse(
        (content as Array<{ id: string; props: { entries: string } }>).find(b => b.id === 'grid')!
          .props.entries
      ) as Array<{ pageId?: string }>;
    expect(grid(payload.content).map(e => e.pageId)).toEqual(['p-pub2', 'p-mem', undefined]);
    expect(grid(anonymous.content).map(e => e.pageId)).toEqual(['p-pub2', undefined]);
    // Signed in, not a member; a signed-in reader has no sign-in link.
    expect(payload.readerSections).toEqual({
      ...anonymous.readerSections,
      signedIn: true,
    });
    expect(payload.signInUrl).toBeNull();
    // Everything else is the anonymous payload, byte for byte.
    const rest = ({
      content: _c,
      links: _l,
      readerSections: _r,
      signInUrl: _s,
      ...other
    }: typeof payload) => other;
    expect(JSON.stringify(rest(payload))).toBe(JSON.stringify(rest(anonymous)));
  });

  test('locked bodies, members-only pages, tick boxes, comments and downloads are out', async () => {
    const { island } = await sitePage('week-1', null);
    const text = json(island);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('lock-body');
    // No members-only page anywhere: not its id, not its title, not its slug.
    for (const leak of ['p-mem', 'Members Lab', 'members-lab']) expect(text).not.toContain(leak);
    // Nor another classroom's page.
    expect(text).not.toContain('p-y');
    expect(island.payload.links).toEqual({
      'p-pub2': { href: '/week-2', title: 'Week 2', membersOnly: false },
    });
    expect(island.payload.readerSections).toMatchObject({
      signedIn: false,
      canCheck: false,
      canUnlock: false,
      staff: false,
    });
    expect(island.payload.readerComments).toBeUndefined();
    expect(island.payload.mediaDownloads).toEqual({});
    expect(fakes.downloadsAsked).toEqual([]);
    expect(island.payload.signInUrl).toBe('/sign-in?returnTo=%2Fweek-1');
    // The schedule tile: the site serves /schedule.
    expect(island.payload.scheduleHref).toBe('/schedule');
    expect(island.surface).toBe('site');
    expect(island.apiBase).toBe('');
  });

  test('the island data block cannot be closed by a paragraph', async () => {
    const { island } = await sitePage('week-1', null);
    const text = json(island);
    expect(text).not.toContain('<');
    expect(JSON.parse(text).payload.content.some((b: { id: string }) => b.id === 'escape')).toBe(
      true
    );
  });

  test('a members-only page: anonymous are sent to sign in, a signed-in stranger is told whose account', async () => {
    const anon = await thrown(() => sitePage('members-lab', null));
    expect(anon.status).toBe(302);
    expect(anon.headers.get('Location')).toBe('/sign-in?returnTo=%2Fmembers-lab');
    // A stranger, a member of another class, someone pending in another class.
    for (const who of ['stranger', 'student-y', 'pending-y']) {
      const refused = await thrown(() => sitePage('members-lab', who));
      expect(refused.status, who).toBe(403);
      expect(await refused.text(), who).toContain('not a member of this class');
    }
  });

  test('a draft is a 404 for everyone, staff included', async () => {
    for (const who of [null, 'student-x', 'owner-x']) {
      const response = await thrown(() => sitePage('draft', who));
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).not.toContain('public');
    }
  });

  test('a custom domain never reads the session: the non-member payload, sign-in on the subdomain, no connections', async () => {
    const anonymous = await sitePage('week-1', null);
    fakes.sessionReads = 0;
    const custom = await sitePage('week-1', 'student-x', { customDomain: 'course.example.edu' });
    expect(fakes.sessionReads).toBe(0);
    expect(custom.island.payload.signInUrl).toBe(
      'https://cs52.classmoji.test/sign-in?returnTo=%2Fweek-1'
    );
    // Identical except for where sign-in lives.
    expect({ ...custom.island.payload, signInUrl: null }).toEqual({
      ...anonymous.island.payload,
      signInUrl: null,
    });
    const csp = custom.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(custom.data.editHref).toBeNull();
  });
});

test.describe('members and staff', () => {
  test('a student member: their own reader, never cacheable', async () => {
    const { island, headers, data } = await sitePage('week-1', 'student-x');
    const payload = island.payload;
    expect(payload.readerSections).toMatchObject({
      signedIn: true,
      canCheck: true,
      canUnlock: true,
      staff: false,
    });
    expect(json(island)).not.toContain(SECRET);
    expect(payload.readerComments).toBeDefined();
    expect(payload.mediaDownloads).toEqual({ 'media://m1': true });
    expect(fakes.downloadsAsked).toEqual([`${X}:STUDENT`]);
    expect(payload.links['p-mem']).toEqual({
      href: '/members-lab',
      title: 'Members Lab',
      membersOnly: true,
    });
    // Another classroom's page is never a link, for anyone.
    expect(payload.links['p-y']).toBeUndefined();
    expect(payload.signInUrl).toBeNull();
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    expect(data.editHref).toBeNull();
    // Downloads go to the pages host.
    expect(island.downloadOrigin).toMatch(/^https?:\/\//);
  });

  test('a section the student unlocked ships its body to them, and only to them', async () => {
    fakes.unlocked['student-x:p-pub'] = { lock: '2026-11-01T00:00:00.000Z' };
    expect(json((await sitePage('week-1', 'student-x')).island)).toContain(SECRET);
    expect(json((await sitePage('week-1', null)).island)).not.toContain(SECRET);
  });

  test('staff see every locked body; owners and teachers get the Edit pill', async () => {
    const owner = await sitePage('week-1', 'owner-x');
    expect(json(owner.island)).toContain(SECRET);
    expect(owner.island.payload.readerSections.staff).toBe(true);
    expect(owner.data.editHref).toMatch(/\/cs52\/p-pub$/);
    const ta = await sitePage('week-1', 'ta-x');
    expect(json(ta.island)).toContain(SECRET);
    expect(ta.data.editHref).toBeNull();
  });

  test('anyone signed in with no recognizable session cookie is still never served publicly', async () => {
    for (const who of ['student-x', 'stranger', 'pending-x']) {
      const { island, headers } = await sitePage('week-1', null, {
        extraHeaders: { 'x-test-user': who },
      });
      expect(island.payload.readerSections.signedIn, who).toBe(true);
      expect(headers.get('Cache-Control'), who).not.toContain('public');
    }
  });

  test('the description is built from the non-member document, whoever reads', async () => {
    fakes.unlocked['student-x:p-pub'] = { lock: '2026-11-01T00:00:00.000Z' };
    const anonymous = await sitePage('week-1', null);
    for (const who of ['student-x', 'owner-x']) {
      const member = await sitePage('week-1', who);
      expect(member.data.description, who).toBe(anonymous.data.description);
    }
    expect(anonymous.data.description).toContain('Welcome to the course');
    expect(anonymous.data.description).not.toContain(SECRET);
  });

  test('impersonated ("View as") member: read-only reader state', async () => {
    const { island } = await sitePage('week-1', 'imp-student-x');
    expect(island.payload.readerSections).toMatchObject({ signedIn: true, canCheck: false });
    expect(island.payload.readerComments).toBeDefined();
  });
});

test.describe('the reader document headers', () => {
  test('scripts from /assets/ and the dark-mode hash only; connections to this origin on the subdomain', async () => {
    const { headers } = await sitePage('week-1', null);
    const csp = headers.get('Content-Security-Policy') ?? '';
    const part = (name: string) => csp.split('; ').find(p => p.startsWith(`${name} `));
    expect(part('script-src')).toBe(`script-src ${HOST}/assets/ ${DARK_MODE_SCRIPT_HASH}`);
    expect(part('connect-src')).toBe("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('a content failure is a 503 that no cache keeps', async () => {
    fakes.contentFails = true;
    const response = await thrown(() => sitePage('week-1', null));
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

test.describe('the home page', () => {
  const home = async (who: string | null) => {
    const result = await homeLoader({
      ...routerArgs(`${HOST}/_site/cs52`, { headers: visitor(who) }),
      params: { subdomain: 'cs52' },
      context: siteRouterContext({ customDomain: null, siteSubdomain: null }),
    });
    return { data: result.data, headers: new Headers(result.init?.headers) };
  };

  test('the home page mounts the same reader with the same rules', async () => {
    const anonymous = await home(null);
    const stranger = await home('stranger');
    expect(anonymous.data.kind).toBe('page');
    const island = anonymous.data.island as ReaderIslandData;
    const strangerIsland = stranger.data.island as ReaderIslandData;
    expect(strangerIsland.payload.readerSections.signedIn).toBe(true);
    expect(json(asSignedOut(strangerIsland))).toBe(json(island));
    expect(stranger.headers.get('Cache-Control')).toBe('private, no-store');
    expect(json(island)).not.toContain(SECRET);
    expect(island.payload.signInUrl).toBe('/sign-in');
    expect(anonymous.headers.get('Cache-Control')).toBe('public, max-age=60');
    const member = await home('student-x');
    expect((member.data.island as ReaderIslandData).payload.readerSections.canCheck).toBe(true);
    expect(member.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

// ─── GET /api/page-reader ────────────────────────────────────────────────────

const onSite = (subdomain: string | null) =>
  siteRouterContext({ customDomain: null, siteSubdomain: subdomain });

async function readerApi(
  pageId: string,
  who: string | null,
  subdomain: string | null = 'cs52',
  extra: Record<string, string> = {}
) {
  return readerRoute({
    request: new Request(
      `http://${subdomain ?? 'pages'}.classmoji.test/api/page-reader?pageId=${pageId}`,
      { headers: visitor(who, extra) }
    ),
    context: onSite(subdomain),
  });
}

test.describe('GET /api/page-reader', () => {
  test('a member gets exactly the page payload, private and never sniffed', async () => {
    const response = await readerApi('p-pub', 'student-x');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const { payload } = await response.json();
    const page = await sitePage('week-1', 'student-x');
    expect(payload).toEqual(page.island.payload);
    expect(fakes.audits).toEqual([]);
  });

  test('after an unlock the new body arrives through it', async () => {
    fakes.unlocked['student-x:p-pub'] = { lock: '2026-11-01T00:00:00.000Z' };
    const { payload } = await (await readerApi('p-pub', 'student-x')).json();
    expect(JSON.stringify(payload)).toContain(SECRET);
    expect(payload.readerSections.unlocked).toEqual({ lock: '2026-11-01T00:00:00.000Z' });
  });

  test('a member of MEMBERS-only page gets it; non-members, pending invites and other classrooms get 404', async () => {
    expect((await readerApi('p-mem', 'student-x')).status).toBe(200);
    for (const who of [null, 'stranger', 'pending-x', 'student-y']) {
      expect((await readerApi('p-pub', who)).status, String(who)).toBe(404);
    }
  });

  test('a page of another classroom, a draft, an unknown id: 404', async () => {
    expect((await readerApi('p-y', 'student-x')).status).toBe(404);
    expect((await readerApi('p-draft', 'owner-x')).status).toBe(404);
    expect((await readerApi('nope', 'student-x')).status).toBe(404);
    expect((await readerApi('../p-pub', 'student-x')).status).toBe(404);
  });

  test('class Y’s member on class X’s host: 404 for X’s page AND for their own page', async () => {
    expect((await readerApi('p-pub', 'student-y', 'cs52')).status).toBe(404);
    expect((await readerApi('p-y', 'student-y', 'cs52')).status).toBe(404);
    // Control: on their own class's host, their own page answers.
    expect((await readerApi('p-y', 'student-y', 'cs53')).status).toBe(200);
    // A member of both classes: each host serves only its own class's pages.
    expect((await readerApi('p-y', 'both', 'cs52')).status).toBe(404);
    expect((await readerApi('p-pub', 'both', 'cs53')).status).toBe(404);
    expect((await readerApi('p-pub', 'both', 'cs52')).status).toBe(200);
  });

  test('not on a site host (no stamp): it does not exist', async () => {
    expect((await readerApi('p-pub', 'student-x', null)).status).toBe(404);
  });

  test('"View as" a member is a read of their state: one VIEW row naming the admin', async () => {
    const response = await readerApi('p-pub', 'imp-student-x');
    expect(response.status).toBe(200);
    expect(fakes.audits).toEqual([
      {
        user_id: 'student-x',
        classroom_id: X,
        role: 'STUDENT',
        resource_type: 'PAGES',
        resource_id: 'p-pub',
        action: 'VIEW',
        data: { tool: 'page_reader', via: 'site', page_id: 'p-pub', impersonated_by: 'admin-1' },
      },
    ]);
  });

  test('a content failure is a JSON 503, never cached', async () => {
    fakes.contentFails = true;
    const response = await readerApi('p-pub', 'student-x');
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

// ─── /api/page-sections and /api/page-comments on a site host ───────────────

const post = (url: string, who: string | null, body: unknown, type = 'application/json') =>
  new Request(url, {
    method: 'POST',
    headers: {
      ...visitor(who),
      'content-type': type,
      origin: new URL(url).origin,
    },
    body: JSON.stringify(body),
  });

test.describe('the reader API on a site host is bound to that site', () => {
  test('a tick for X’s page on X’s host: allowed, audited via site', async () => {
    const response = await sectionsAction({
      request: post(`${HOST}/api/page-sections`, 'student-x', {
        pageId: 'p-pub',
        blockId: 'h-check',
        intent: 'check',
      }),
      context: onSite('cs52'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(fakes.sectionWrites).toEqual(['check:h-check']);
    expect((fakes.audits[0].data as { via: string }).via).toBe('site');
  });

  test('a member of Y on X’s host, or X’s member on Y’s host: 404 and nothing written', async () => {
    for (const [who, host, pageId] of [
      ['student-y', 'cs52', 'p-y'],
      ['student-y', 'cs52', 'p-pub'],
      ['student-x', 'cs53', 'p-pub'],
      // A member of X, on X's host, about a page of Y: not this site's page.
      ['student-x', 'cs52', 'p-y'],
      // A member of BOTH, on X's host, about Y's page: still not this site's.
      ['both', 'cs52', 'p-y'],
      ['both', 'cs53', 'p-pub'],
    ] as const) {
      const response = await sectionsAction({
        request: post(`http://${host}.classmoji.test/api/page-sections`, who, {
          pageId,
          blockId: 'h-check',
          intent: 'check',
        }),
        context: onSite(host),
      });
      expect(response.status, `${who}@${host}:${pageId}`).toBe(404);
    }
    expect(fakes.sectionWrites).toEqual([]);
  });

  test('a draft or a non-JSON body on a site host is refused', async () => {
    const draft = await sectionsAction({
      request: post(`${HOST}/api/page-sections`, 'owner-x', {
        pageId: 'p-draft',
        blockId: 'h-check',
        intent: 'check',
      }),
      context: onSite('cs52'),
    });
    expect(draft.status).toBe(404);
    const plain = await sectionsAction({
      request: post(
        `${HOST}/api/page-sections`,
        'student-x',
        { pageId: 'p-pub', blockId: 'h-check', intent: 'check' },
        'text/plain'
      ),
      context: onSite('cs52'),
    });
    expect(plain.status).toBe(415);
    expect(fakes.sectionWrites).toEqual([]);
  });

  test('on the pages host itself (no stamp) the app’s rules are unchanged', async () => {
    const response = await sectionsAction({
      request: post('http://pages.classmoji.test/api/page-sections', 'student-x', {
        pageId: 'p-pub',
        blockId: 'h-check',
        intent: 'check',
      }),
      context: onSite(null),
    });
    expect(response.status).toBe(200);
    expect((fakes.audits[0].data as { via: string }).via).toBe('web');
  });

  test('comments: the same binding for GET and POST, JSON required on the site', async () => {
    const list = (who: string, host: string, pageId: string) =>
      commentsLoader({
        request: new Request(`http://${host}.classmoji.test/api/page-comments?pageId=${pageId}`, {
          headers: visitor(who),
        }),
        context: onSite(host),
      });
    expect((await list('student-y', 'cs52', 'p-y')).status).toBe(404);
    expect((await list('student-y', 'cs52', 'p-pub')).status).toBe(404);
    expect((await list('both', 'cs52', 'p-y')).status).toBe(404);
    const plain = await commentsAction({
      request: post(
        `${HOST}/api/page-comments`,
        'student-x',
        { pageId: 'p-pub', intent: 'create', body: 'hi' },
        'text/plain'
      ),
      context: onSite('cs52'),
    });
    expect(plain.status).toBe(415);
    const cross = await commentsAction({
      request: post(`${HOST}/api/page-comments`, 'student-y', {
        pageId: 'p-y',
        intent: 'create',
        body: 'hi',
      }),
      context: onSite('cs52'),
    });
    expect(cross.status).toBe(404);
    expect(cross.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

// ─── The island's refresh ────────────────────────────────────────────────────

test.describe('the site island’s refresh', () => {
  const data = (signedIn: boolean, member = signedIn) =>
    ({
      surface: 'site',
      page: { id: 'p-pub', title: 'Week 1', width: 2, is_draft: false },
      payload: { content: [], readerSections: { signedIn, member } },
      apiBase: '',
    }) as unknown as ReaderIslandData;

  test('only a member’s reader refreshes; a non-member’s makes no request', () => {
    expect(hostOptionsFor(data(false))).toEqual({});
    expect(typeof hostOptionsFor(data(true)).onRefresh).toBe('function');
    expect(hostOptionsFor({ ...data(true), surface: 'render' })).toEqual({});
    // Signed in but not an accepted member (a stranger, a pending member): none.
    expect(hostOptionsFor(data(true, false))).toEqual({});
  });

  test('fetches /api/page-reader with no cache and resolves with the new payload; rejects on a refusal', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const payload = { content: [{ id: 'a' }], readerSections: { signedIn: true } };
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Response.json({ payload });
    }) as typeof fetch;
    expect(await fetchSiteReaderPayload(data(true), ok)).toEqual(payload);
    expect(calls[0][0]).toBe('/api/page-reader?pageId=p-pub');
    expect(calls[0][1]?.cache).toBe('no-store');
    const refused = (async () =>
      Response.json({ error: 'Not found' }, { status: 404 })) as typeof fetch;
    await expect(fetchSiteReaderPayload(data(true), refused)).rejects.toThrow();
    const empty = (async () => Response.json({})) as typeof fetch;
    await expect(fetchSiteReaderPayload(data(true), empty)).rejects.toThrow();
  });
});

// ─── Follow-ups from review ──────────────────────────────────────────────────

test.describe('a page that never mounts does not sit on its loading line', () => {
  // The rendered markup is checked on the real document by the end-to-end run
  // (JSX from app modules cannot be server-rendered under this runner).
  test('the site mount element: a noscript line, and a CSS-only swap to the failure line', async () => {
    const { readFileSync } = await import('node:fs');
    const { ISLAND_NOSCRIPT_MESSAGE, ISLAND_STALLED_MESSAGE } =
      await import('../../app/reader-island/ReaderIsland.tsx');
    const { SITE_STYLES } = await import('../../app/site/styles.ts');
    const island = readFileSync(
      new URL('../../app/reader-island/ReaderIsland.tsx', import.meta.url),
      'utf8'
    );
    expect(island).toContain(
      '<span className="reader-island-wait-failed">{ISLAND_STALLED_MESSAGE}</span>'
    );
    expect(island).toMatch(
      /<noscript>\s*<div className="reader-island-noscript">\{ISLAND_NOSCRIPT_MESSAGE\}<\/div>\s*<\/noscript>/
    );
    expect(ISLAND_STALLED_MESSAGE).toBe('This page could not be shown. Reload to try again.');
    expect(ISLAND_NOSCRIPT_MESSAGE).toBe('This page needs JavaScript to show its content.');
    for (const route of ['page.tsx', 'home.tsx']) {
      const text = readFileSync(new URL(`../../app/site/${route}`, import.meta.url), 'utf8');
      expect(text, route).toMatch(/className="site-reader-root"\s+stalledFallback/);
    }
    // The MCP's page render keeps its own loading line.
    const render = readFileSync(new URL('../../app/render/page.tsx', import.meta.url), 'utf8');
    expect(render).not.toContain('stalledFallback');
    // The rules live in the inline site sheet (no other file may have loaded).
    expect(SITE_STYLES).toMatch(
      /\.reader-island-wait-failed \{\s*visibility: hidden;\s*animation: reader-island-stalled-in 0s linear 10s forwards;/
    );
    expect(SITE_STYLES).toMatch(
      /\.reader-island-wait-loading \{\s*animation: reader-island-stalled-out 0s linear 10s forwards;/
    );
    expect(SITE_STYLES).toContain('.site-reader-root { min-height: 60vh; }');
    expect(SITE_STYLES).toContain(
      '.site-reader-root:has(.page-reader[data-reader-ready]) { min-height: 0; }'
    );
    // Never switched off for reduced motion (only the fade is).
    expect(SITE_STYLES).not.toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*reader-island-wait/);
  });
});

test.describe('first-image preloads', () => {
  test('a non-member preloads the first visible image, never a locked-body image', async () => {
    const { data } = await sitePage('week-1', null);
    expect(data.imagePreloads).toEqual([
      {
        href: 'https://content.test/top.png?sig',
        imageSrcSet: 'https://content.test/top-480.png 480w, https://content.test/top.png 1024w',
        imageSizes: 'min(100vw, 480px)',
        fetchPriority: 'high',
      },
    ]);
    expect(JSON.stringify(data)).not.toContain('LOCKED.png');
  });

  test('staff (every body shown) preload the first two images, in document order', async () => {
    const { data } = await sitePage('week-1', 'owner-x');
    const preloads = data.imagePreloads as Array<{ href: string; fetchPriority?: string }>;
    expect(preloads.map(p => p.href)).toEqual([
      'https://content.test/top.png?sig',
      'https://content.test/LOCKED.png?sig',
    ]);
    expect(preloads[1].fetchPriority).toBeUndefined();
  });

  test('none for an empty document, a data URL or an unresolved reference', async () => {
    const { imagePreloadsFor } = await import('../../app/site/imagePreloads.ts');
    const base = { assets: {}, srcSets: {} } as never;
    expect(imagePreloadsFor({ ...(base as object), content: [] } as never)).toEqual([]);
    expect(
      imagePreloadsFor({
        ...(base as object),
        content: [
          { type: 'image', props: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image', props: { url: 'media://nope' } },
          { type: 'image', props: { url: '//evil.test/x.png' } },
          {
            type: 'toggleListItem',
            children: [{ type: 'image', props: { url: 'https://x.test/hidden.png' } }],
          },
        ],
      } as never)
    ).toEqual([]);
  });
});

test.describe('scroll memory (site)', () => {
  test('saves on pagehide per path; restores after settling unless a hash, a user scroll or nothing saved', async () => {
    const { keepScrollPosition, saveScroll, savedScroll, scrollKey } =
      await import('../../app/reader-island/scrollMemory.ts');
    const fakeWindow = (pathname: string, hash = '', store = new Map<string, string>()) => {
      const listeners = new Map<string, Array<() => void>>();
      const scrolls: number[] = [];
      const win = {
        location: { pathname, hash },
        history: { scrollRestoration: 'auto' },
        scrollY: 0,
        sessionStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => void store.set(k, v),
        },
        addEventListener: (name: string, fn: () => void) =>
          listeners.set(name, [...(listeners.get(name) ?? []), fn]),
        removeEventListener: (name: string, fn: () => void) =>
          listeners.set(
            name,
            (listeners.get(name) ?? []).filter(f => f !== fn)
          ),
        scrollTo: (_x: number, y: number) => scrolls.push(y),
        fire: (name: string) => (listeners.get(name) ?? []).forEach(f => f()),
      };
      return { win, scrolls, store };
    };
    const first = fakeWindow('/week-1');
    keepScrollPosition(first.win as unknown as Window);
    expect(first.win.history.scrollRestoration).toBe('manual');
    first.win.scrollY = 1234;
    first.win.fire('pagehide');
    expect(first.store.get(scrollKey('/week-1'))).toBe('1234');

    const back = fakeWindow('/week-1', '', first.store);
    keepScrollPosition(back.win as unknown as Window)();
    expect(back.scrolls).toEqual([1234]);

    const other = fakeWindow('/week-2', '', first.store);
    keepScrollPosition(other.win as unknown as Window)();
    expect(other.scrolls).toEqual([]);

    const hashed = fakeWindow('/week-1', '#setup', first.store);
    keepScrollPosition(hashed.win as unknown as Window)();
    expect(hashed.scrolls).toEqual([]);

    const moved = fakeWindow('/week-1', '', first.store);
    const restore = keepScrollPosition(moved.win as unknown as Window);
    moved.win.fire('wheel');
    restore();
    expect(moved.scrolls).toEqual([]);

    // A store that throws is no store.
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => saveScroll(broken, '/x', 10)).not.toThrow();
    expect(savedScroll(broken, '/x')).toBeNull();
  });
});

test.describe('audited reads on a site host refuse other sites', () => {
  test('/api/page-reader: same-origin or no header answers; cross-site, same-site and none get 404', async () => {
    expect(
      (await readerApi('p-pub', 'imp-student-x', 'cs52', { 'sec-fetch-site': 'same-origin' }))
        .status
    ).toBe(200);
    expect((await readerApi('p-pub', 'imp-student-x', 'cs52')).status).toBe(200);
    expect(fakes.audits).toHaveLength(2);
    for (const value of ['cross-site', 'same-site', 'none']) {
      expect(
        (await readerApi('p-pub', 'imp-student-x', 'cs52', { 'sec-fetch-site': value })).status,
        value
      ).toBe(404);
    }
    expect(fakes.audits).toHaveLength(2);
  });

  test('GET /api/page-sections (staff activity): the same rule on a site host, unchanged on the pages host', async () => {
    const { loader: sectionsLoader } = await importTreeWithStubs<{ loader: Route }>(
      new URL('../../app/routes/api.page-sections/route.ts', import.meta.url),
      STUBS,
      'site-reader'
    );
    const list = (host: string | null, extra: Record<string, string>) =>
      sectionsLoader({
        request: new Request(
          `http://${host ?? 'pages'}.classmoji.test/api/page-sections?pageId=p-pub&blockId=lock`,
          { headers: visitor('owner-x', extra) }
        ),
        context: onSite(host),
      });
    expect((await list('cs52', {})).status).toBe(200);
    expect((await list('cs52', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect(fakes.audits.map(a => (a.data as { via: string }).via)).toEqual(['site', 'site']);
    expect((await list('cs52', { 'sec-fetch-site': 'cross-site' })).status).toBe(404);
    expect((await list('cs52', { 'sec-fetch-site': 'same-site' })).status).toBe(404);
    expect(fakes.audits).toHaveLength(2);
    // The pages host itself: not judged by the header (as before).
    expect((await list(null, { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
  });
});

test.describe('on a site host the reader rule is accepted memberships only', () => {
  test('a student with a pending teacher invite unlocks like a student on the site (staff reveal on the pages host)', async () => {
    const unlock = (host: string | null) =>
      sectionsAction({
        request: post(`http://${host ?? 'pages'}.classmoji.test/api/page-sections`, 'dual', {
          pageId: 'p-pub',
          blockId: 'lock',
          intent: 'unlock',
        }),
        context: onSite(host),
      });
    expect((await unlock('cs52')).status).toBe(200);
    expect(fakes.sectionWrites).toEqual(['unlock:lock']);
    // The pages host keeps the app's any-invite-state rule: staff, no unlock.
    expect((await unlock(null)).status).toBe(409);
  });

  test('comments: no staff reveal on the site for a pending invite; the pages host unchanged', async () => {
    const list = (host: string | null) =>
      commentsLoader({
        request: new Request(
          `http://${host ?? 'pages'}.classmoji.test/api/page-comments?pageId=p-pub`,
          {
            headers: visitor('dual'),
          }
        ),
        context: onSite(host),
      });
    expect((await list('cs52')).status).toBe(200);
    expect((await list(null)).status).toBe(200);
    expect(fakes.commentViewers).toEqual([false, true]);
  });
});

// ─── A pending member on the site: reading, nothing more ─────────────────────

test.describe('a pending member reads the site’s members-only pages, and nothing more', () => {
  test('a pending member of X opens X’s members-only page: no reader state, comments or downloads, locked bodies out', async () => {
    fakes.unlocked['pending-x:p-mem'] = { lock: '2026-11-01T00:00:00.000Z' };
    const { status, island, headers, data } = await sitePage('members-lab', 'pending-x');
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    const payload = island.payload;
    expect(payload.readerSections).toEqual({
      staff: false,
      signedIn: true,
      member: false,
      canCheck: false,
      canUnlock: false,
      checked: [],
      unlocked: {},
    });
    expect('readerComments' in payload).toBe(false);
    expect(payload.mediaDownloads).toEqual({});
    expect(fakes.downloadsAsked).toEqual([]);
    expect(json(island)).not.toContain(SECRET);
    expect(json(island)).not.toContain('lock-body');
    // Member-visible links, as the app gives them; never another class's page.
    expect(payload.links['p-mem']).toEqual({
      href: '/members-lab',
      title: 'Members Lab',
      membersOnly: true,
    });
    expect(payload.links['p-y']).toBeUndefined();
    // No staff chrome for a pending row.
    expect(data.editHref).toBeNull();
    expect(data.legacyNotice).toBe(false);
  });

  test('a pending TEACHER row reveals no locked body and opens no draft on the site', async () => {
    const page = await sitePage('week-1', 'pending-x');
    expect(page.island.payload.readerSections.staff).toBe(false);
    expect(json(page.island)).not.toContain(SECRET);
    expect(fakes.commentViewers).toEqual([]);
    const draft = await thrown(() => sitePage('draft', 'pending-x'));
    expect(draft.status).toBe(404);
  });

  test('an accepted student holding a pending teacher invite stays a student member', async () => {
    const { island } = await sitePage('members-lab', 'dual');
    expect(island.payload.readerSections).toMatchObject({
      staff: false,
      member: true,
      canUnlock: true,
    });
    expect(json(island)).not.toContain(SECRET);
  });

  test('the site’s home page: the same reading rules', async () => {
    const result = await homeLoader({
      ...routerArgs(`${HOST}/_site/cs52`, { headers: visitor('pending-x') }),
      params: { subdomain: 'cs52' },
      context: siteRouterContext({ customDomain: null, siteSubdomain: null }),
    });
    const island = result.data.island as ReaderIslandData;
    expect(island.payload.readerSections).toMatchObject({ signedIn: true, member: false });
    expect(island.payload.links['p-mem']?.membersOnly).toBe(true);
    expect(new Headers(result.init?.headers).get('Cache-Control')).toBe('private, no-store');
  });

  test('the three site APIs still refuse a pending member', async () => {
    expect((await readerApi('p-pub', 'pending-x')).status).toBe(404);
    expect((await readerApi('p-mem', 'pending-x')).status).toBe(404);
    for (const intent of ['check', 'unlock'] as const) {
      const response = await sectionsAction({
        request: post(`${HOST}/api/page-sections`, 'pending-x', {
          pageId: 'p-mem',
          blockId: intent === 'check' ? 'h-check' : 'lock',
          intent,
        }),
        context: onSite('cs52'),
      });
      expect(response.status, intent).toBe(404);
    }
    expect(fakes.sectionWrites).toEqual([]);
    const list = await commentsLoader({
      request: new Request(`${HOST}/api/page-comments?pageId=p-mem`, {
        headers: visitor('pending-x'),
      }),
      context: onSite('cs52'),
    });
    expect(list.status).toBe(404);
    const create = await commentsAction({
      request: post(`${HOST}/api/page-comments`, 'pending-x', {
        pageId: 'p-mem',
        intent: 'create',
        body: 'hi',
      }),
      context: onSite('cs52'),
    });
    expect(create.status).toBe(404);
    expect(fakes.audits).toEqual([]);
  });
});

// ─── Locked sections for a signed-in non-member ──────────────────────────────

test.describe('a locked section for a signed-in non-member', () => {
  test('the payload says signed in and not a member: anonymous, stranger, pending, member', async () => {
    const sections = async (who: string | null) =>
      (await sitePage('week-1', who)).island.payload.readerSections;
    expect(await sections(null)).toMatchObject({ signedIn: false, member: false });
    expect(await sections('stranger')).toMatchObject({ signedIn: true, member: false });
    expect(await sections('pending-x')).toMatchObject({ signedIn: true, member: false });
    expect(await sections('student-x')).toMatchObject({ signedIn: true, member: true });
    // An impersonated member is still a member (a closed card, not the line).
    expect(await sections('imp-student-x')).toMatchObject({ member: true, canUnlock: false });
  });

  test('the reader: sign-in for a signed-out reader, the one members-only line for a signed-in non-member', async () => {
    const { readFileSync } = await import('node:fs');
    const { MEMBERS_ONLY_UNLOCK } =
      await import('../../app/components/viewer/sections/LockedSectionView.tsx');
    expect(MEMBERS_ONLY_UNLOCK).toBe('Only class members can unlock this.');
    const view = readFileSync(
      new URL('../../app/components/viewer/sections/LockedSectionView.tsx', import.meta.url),
      'utf8'
    );
    expect(view).toContain(
      "  else if (!sections.signedIn) mode = 'signin';\n  else if (!sections.member) mode = 'members';\n  else mode = 'closed';"
    );
    // The line is text, with no link; the members' note is unchanged.
    const members = view.slice(view.indexOf('function MembersOnlyUnlock'));
    expect(members.slice(0, members.indexOf('\n}\n'))).not.toContain('<a ');
    expect(view).toContain('Staff can see when you unlock this.');
  });
});

// ─── "View as" on a page load ────────────────────────────────────────────────

test.describe('"View as": the first load of a page carrying that user’s reader state is audited', () => {
  const viewRow = (resourceId: string, via: 'site' | 'web') => ({
    user_id: 'student-x',
    classroom_id: X,
    role: 'STUDENT',
    resource_type: 'PAGES',
    resource_id: resourceId,
    action: 'VIEW',
    data: { tool: 'page_reader', via, page_id: resourceId, impersonated_by: 'admin-1' },
  });

  test('a site page: exactly one VIEW row, via the site', async () => {
    expect((await sitePage('week-1', 'imp-student-x')).status).toBe(200);
    expect(fakes.audits).toEqual([viewRow('p-pub', 'site')]);
  });

  test('the site’s home page: exactly one VIEW row for the home page', async () => {
    await homeLoader({
      ...routerArgs(`${HOST}/_site/cs52`, { headers: visitor('imp-student-x') }),
      params: { subdomain: 'cs52' },
      context: siteRouterContext({ customDomain: null, siteSubdomain: null }),
    });
    expect(fakes.audits).toEqual([viewRow('p-home', 'site')]);
  });

  test('the pages app’s page: exactly one VIEW row, via the web', async () => {
    const appPage = (who: string | null) =>
      appPageLoader({
        ...routerArgs('http://pages.classmoji.test/cs52/p-pub', { headers: visitor(who) }),
        params: { classroomSlug: 'cs52', pageId: 'p-pub' },
      });
    const data = await appPage('imp-student-x');
    expect((data.reader as { readerSections: { member: boolean } }).readerSections.member).toBe(
      true
    );
    expect(fakes.audits).toEqual([viewRow('p-pub', 'web')]);
    // A user loading their own page writes nothing; neither does anyone signed out.
    fakes.audits = [];
    await appPage('student-x');
    await appPage(null);
    expect(fakes.audits).toEqual([]);
    // Viewing as a non-member (no reader state ships): nothing.
    await appPage('imp-stranger');
    expect(fakes.audits).toEqual([]);
  });

  test('not impersonated, or impersonating someone with no reader state here: no row', async () => {
    await sitePage('week-1', 'student-x');
    await sitePage('week-1', null);
    await sitePage('week-1', 'imp-stranger');
    await sitePage('members-lab', 'imp-pending-x');
    await homeLoader({
      ...routerArgs(`${HOST}/_site/cs52`, { headers: visitor('imp-stranger') }),
      params: { subdomain: 'cs52' },
      context: siteRouterContext({ customDomain: null, siteSubdomain: null }),
    });
    expect(fakes.audits).toEqual([]);
  });
});

// ─── Review follow-ups ───────────────────────────────────────────────────────

/** The pages app's page loader for `who` on X's `pageId`. */
const appPage = (who: string | null, pageId = 'p-pub', method = 'GET') =>
  appPageLoader({
    ...routerArgs(`http://pages.classmoji.test/cs52/${pageId}`, {
      method,
      headers: visitor(who),
    }),
    params: { classroomSlug: 'cs52', pageId },
  });

test.describe('the frame hosts reach every surface as the server names them', () => {
  const ENV = {
    WEBAPP_URL: 'https://app.classmoji.test',
    PAGES_URL: 'https://pages.classmoji.test',
    SLIDES_URL: 'https://slides.classmoji.test',
    CONTENT_DELIVERY_ORIGIN: 'https://content.classmoji.test',
    SITE_BASE_DOMAIN: 'classmoji.test',
  };
  const saved: Record<string, string | undefined> = {};
  test.beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  test.afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('the class site (buildSitePayload) ships ownFrameHosts()', async () => {
    const expected = ownFrameHosts();
    expect(expected.siteDomain).toBe('classmoji.test');
    for (const who of [null, 'student-x', 'pending-x']) {
      expect((await sitePage('week-1', who)).island.payload.frameHosts, String(who)).toEqual(
        expected
      );
    }
    expect((await readerApi('p-pub', 'student-x')).status).toBe(200);
  });

  test('the pages app: the reader payload and the editors’ loader data carry ownFrameHosts()', async () => {
    const expected = ownFrameHosts();
    const reader = await appPage('student-x');
    expect((reader.reader as { frameHosts: unknown }).frameHosts).toEqual(expected);
    expect(reader.frameHosts).toEqual(expected);
    // An owner gets the editor: no reader payload, the hosts in the loader data.
    const editor = await appPage('owner-x');
    expect(editor.reader).toBeNull();
    expect(editor.canEdit).toBe(true);
    expect(editor.frameHosts).toEqual(expected);
  });
});

test.describe('a pending OWNER row on the site reads, and nothing more', () => {
  test('no locked bodies, no staff chrome, no drafts', async () => {
    for (const slug of ['week-1', 'members-lab']) {
      const { status, island, data } = await sitePage(slug, 'pending-owner');
      expect(status, slug).toBe(200);
      expect(island.payload.readerSections, slug).toMatchObject({
        staff: false,
        member: false,
        canCheck: false,
        canUnlock: false,
      });
      expect(json(island), slug).not.toContain(SECRET);
      expect('readerComments' in island.payload, slug).toBe(false);
      expect(island.payload.mediaDownloads, slug).toEqual({});
      expect(data.editHref, slug).toBeNull();
      expect(data.legacyNotice, slug).toBe(false);
    }
    expect((await thrown(() => sitePage('draft', 'pending-owner'))).status).toBe(404);
  });

  test('the site APIs refuse it', async () => {
    expect((await readerApi('p-mem', 'pending-owner')).status).toBe(404);
    const unlock = await sectionsAction({
      request: post(`${HOST}/api/page-sections`, 'pending-owner', {
        pageId: 'p-pub',
        blockId: 'lock',
        intent: 'unlock',
      }),
      context: onSite('cs52'),
    });
    expect(unlock.status).toBe(404);
    const activity = await (
      await importTreeWithStubs<{ loader: Route }>(
        new URL('../../app/routes/api.page-sections/route.ts', import.meta.url),
        STUBS,
        'site-reader'
      )
    ).loader({
      request: new Request(`${HOST}/api/page-sections?pageId=p-pub&blockId=lock`, {
        headers: visitor('pending-owner'),
      }),
      context: onSite('cs52'),
    });
    expect(activity.status).toBe(404);
    const comments = await commentsLoader({
      request: new Request(`${HOST}/api/page-comments?pageId=p-pub`, {
        headers: visitor('pending-owner'),
      }),
      context: onSite('cs52'),
    });
    expect(comments.status).toBe(404);
    expect(fakes.sectionWrites).toEqual([]);
    expect(fakes.audits).toEqual([]);
  });
});

test.describe('"View as" audit on load: HEAD and a failing write', () => {
  test('a HEAD load writes no row, on the site and in the app', async () => {
    await sitePage('week-1', 'imp-student-x', { method: 'HEAD' });
    await appPage('imp-student-x', 'p-pub', 'HEAD');
    expect(fakes.audits).toEqual([]);
    // Control: the same loads as GET write one row each.
    await sitePage('week-1', 'imp-student-x');
    await appPage('imp-student-x');
    expect(fakes.audits.map(row => (row.data as { via: string }).via)).toEqual(['site', 'web']);
  });

  test('a failing audit write does not fail the page, on the site or in the app', async () => {
    fakes.auditThrows = true;
    const site = await sitePage('week-1', 'imp-student-x');
    expect(site.status).toBe(200);
    expect(site.island.payload.readerSections.member).toBe(true);
    const app = await appPage('imp-student-x');
    expect((app.reader as { readerSections: { member: boolean } }).readerSections.member).toBe(
      true
    );
    const home = await homeLoader({
      ...routerArgs(`${HOST}/_site/cs52`, { headers: visitor('imp-student-x') }),
      params: { subdomain: 'cs52' },
      context: siteRouterContext({ customDomain: null, siteSubdomain: null }),
    });
    expect((home.data.island as ReaderIslandData).payload.readerSections.member).toBe(true);
  });
});

test.describe('the class site’s schedule reads like its pages', () => {
  const schedule = async (who: string | null) => {
    const result = await scheduleLoader({
      ...routerArgs(`${HOST}/_site/cs52/schedule`, { headers: visitor(who) }),
      params: { subdomain: 'cs52' },
      context: siteRouterContext({ customDomain: null, siteSubdomain: null }),
    });
    return new Headers(result.init?.headers).get('Cache-Control');
  };

  test('a pending member gets the members’ schedule; strangers and other classes the public one', async () => {
    expect(await schedule(null)).toBe('public, max-age=60');
    expect(await schedule('stranger')).toBe('private, no-store');
    expect(await schedule('pending-y')).toBe('private, no-store');
    expect(await schedule('pending-x')).toBe('private, no-store');
    expect(await schedule('student-x')).toBe('private, no-store');
    // The role the service lists with: null for a non-member, a role for a
    // pending or accepted member (the service never lists drafts for anyone).
    expect(fakes.scheduleRoles).toEqual([null, null, null, 'TEACHER', 'STUDENT']);
  });

  test('anyone signed in, with no recognizable cookie, is never served the shared copy', async () => {
    const result = await scheduleLoader({
      ...routerArgs(`${HOST}/_site/cs52/schedule`, { headers: { 'x-test-user': 'stranger' } }),
      params: { subdomain: 'cs52' },
      context: siteRouterContext({ customDomain: null, siteSubdomain: null }),
    });
    expect(new Headers(result.init?.headers).get('Cache-Control')).not.toContain('public');
  });
});
