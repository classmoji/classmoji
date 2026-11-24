/**
 * `/_render/page/:pageId` — the MCP's `page_render` page — on the reader
 * island: the REAL loader (`utils/pageView.server.ts`) and the REAL payload
 * builder, with only their I/O swapped for fakes (`importWithStubs`): the
 * database, the view token, git, the collab server, asset signing and the
 * island's build assets. Also the route's own CSP and the document the root
 * gives render paths.
 *
 * What the render shows did not change with the island: a STAFF view (every
 * locked body), no comments, no downloads, page links as the render always
 * drew them (every page of the classroom the document names, `#`, live
 * title), legacy pages refused, and the live snapshot / git main / preview
 * branch chosen exactly as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { VIEW_HEADERS } from '@classmoji/services/render-contract';
import { importWithStubs, routerArgs, stubModule } from '../helpers/dataRequest.helpers.ts';
import {
  isRenderDataRequest,
  renderContentSecurityPolicy,
  renderDataRequestRefusal,
  renderPageHeaders,
} from '../../app/render/headers.server.ts';
import { DARK_MODE_SCRIPT_HASH } from '../../app/site/headers.server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAGE_ID = 'page-1';
const CLASS_ID = 'class-1';
const LINKED = 'page-linked';
const DRAFT_LINKED = 'page-draft';
const OTHER_CLASS_PAGE = 'page-elsewhere';

interface Fakes {
  token: boolean;
  collabEnabled: boolean;
  snapshot: 'ok' | 'fails';
  gitFormat: 'json' | 'html';
  calls: string[];
}
const fakes: Fakes = {
  token: true,
  collabEnabled: false,
  snapshot: 'ok',
  gitFormat: 'json',
  calls: [],
};
(globalThis as unknown as { __renderFakes: Fakes }).__renderFakes = fakes;

const BLOCKS = [
  {
    id: 'p1',
    type: 'paragraph',
    props: {},
    content: [{ type: 'text', text: 'Intro' }],
    children: [],
  },
  {
    id: 'lock',
    type: 'lockedSection',
    props: { title: 'Solution' },
    content: [],
    children: [
      {
        id: 'lock-body',
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'The answer' }],
        children: [],
      },
    ],
  },
  {
    id: 'l1',
    type: 'pageLink',
    props: { pageId: LINKED, pageTitle: 'Stored title' },
    children: [],
  },
  { id: 'l2', type: 'pageLink', props: { pageId: DRAFT_LINKED, pageTitle: 'Draft' }, children: [] },
  {
    id: 'l3',
    type: 'pageLink',
    props: { pageId: OTHER_CLASS_PAGE, pageTitle: 'Elsewhere' },
    children: [],
  },
  {
    id: 'l4',
    type: 'pageLink',
    props: { pageId: 'page-missing', pageTitle: 'Gone' },
    children: [],
  },
  {
    id: 'grid',
    type: 'navGrid',
    props: {
      entries: JSON.stringify([{ kind: 'schedule' }, { kind: 'page', pageId: LINKED, title: '' }]),
    },
    children: [],
  },
];
(globalThis as unknown as { __renderBlocks: unknown }).__renderBlocks = BLOCKS;

const F = 'const f = () => globalThis.__renderFakes;';
/** One module (one URL), so the loader's `instanceof` sees the class the fake collab throws. */
const COLLAB_ENV_STUB = stubModule('export class CollabRequestError extends Error {}');

const STUBS = {
  '/app/utils/db.server.ts': stubModule(`${F}
export const prisma = {
  page: {
    findUnique: async ({ where }) => where.id === 'page-1' ? {
      id: 'page-1', title: 'Week 1', width: 3, is_draft: true, is_public: false,
      content_path: 'pages/week-1', classroom_id: 'class-1',
      header_image_url: null, header_image_position: null,
      classroom: { id: 'class-1', slug: 'cs1', collab_enabled: f().collabEnabled, content_key_version: 4,
        git_organization: { provider: 'GITHUB', login: 'org' } },
    } : null,
  },
};
export const ClassmojiService = {
  contentDelivery: { tierFor: ({ isPublic }) => { f().calls.push('tier:' + isPublic); return 'week'; } },
  pageContent: {
    previewBranchName: p => 'preview/' + p,
    loadPageContent: async (page, opts) => {
      f().calls.push('git:' + (opts.ref ?? 'main'));
      return f().gitFormat === 'json'
        ? { format: 'json', blocks: globalThis.__renderBlocks, coverImage: { url: 'assets/cover.png', position: 20 }, sha: 'sha-1' }
        : { format: 'html', content: '<p>old</p>', coverImage: null, sha: 'html-sha' };
    },
  },
};
`),
  '@classmoji/services/render-token': stubModule(`${F}
export const verifyDocViewToken = async (token, target) => {
  f().calls.push('verify:' + target.target + ':' + target.keyVersion);
  return f().token ? { ok: true } : { ok: false, reason: 'bad-signature' };
};
`),
  '/app/utils/collabEnv.server.ts': COLLAB_ENV_STUB,
  '/app/utils/collab.server.ts': stubModule(`${F}
import { CollabRequestError } from '${COLLAB_ENV_STUB}';
export const liveEditingEnv = c => (c.collab_enabled ? { httpUrl: 'http://collab', secret: 's' } : null);
export const fetchLiveSnapshot = async () => {
  f().calls.push('snapshot');
  if (f().snapshot === 'fails') throw new CollabRequestError('timeout');
  return { epoch: 2, version: 9, content: { blocks: globalThis.__renderBlocks, coverImage: null } };
};
`),
  '/app/utils/readerDeps.server.ts': stubModule(`${F}
export const readerPayloadDeps = {
  assetContext: () => ({ ctx: true }),
  resolveAssets: async () => ({ assets: { 'assets/cover.png': 'https://cdn/cover.png?sig' }, srcSets: {} }),
  loadMediaDownloads: async () => { f().calls.push('downloads'); return {}; },
  linkedPages: async (classroomId, ids) => {
    f().calls.push('linked:' + classroomId + ':' + [...ids].sort().join(','));
    return [
      { id: 'page-linked', classroom_id: 'class-1', title: 'Live title', slug: 'w', is_public: false, is_draft: false },
      { id: 'page-draft', classroom_id: 'class-1', title: '', slug: 'd', is_public: true, is_draft: true },
      // A row from another classroom must never become a link.
      { id: 'page-elsewhere', classroom_id: 'class-2', title: 'Elsewhere', slug: 'e', is_public: true, is_draft: false },
    ];
  },
  readerComments: async () => { f().calls.push('comments'); return { pageLevel: 1 }; },
};
`),
  '/app/reader-island/assets.server.ts': stubModule(
    "export const readerIslandAssets = { dev: false, entry: '/assets/entry.js', css: ['/assets/r.css'], preloads: ['/assets/m.js'] };"
  ),
};

type IslandPayload = {
  content: Array<{ id: string; type: string; props: Record<string, unknown>; children: unknown[] }>;
  coverImage: unknown;
  assets: Record<string, string>;
  readerSections: Record<string, unknown>;
  readerComments?: unknown;
  mediaDownloads: Record<string, unknown>;
  links: Record<string, { href: string; title: string; membersOnly: boolean }>;
  scheduleHref: string | null;
  signInUrl: string | null;
};
interface ViewData {
  island: { surface: string; page: Record<string, unknown>; payload: IslandPayload };
  assets: unknown;
  meta: { kind: string; version: string };
}

let pageViewLoader: (args: unknown) => Promise<ViewData>;

test.beforeAll(async () => {
  ({ pageViewLoader } = await importWithStubs<{ pageViewLoader: typeof pageViewLoader }>(
    new URL('../../app/utils/pageView.server.ts', import.meta.url),
    STUBS
  ));
});

async function load(over: Partial<Fakes> = {}, query = '?at=main&pin=head') {
  Object.assign(fakes, {
    token: true,
    collabEnabled: false,
    snapshot: 'ok',
    gitFormat: 'json',
    calls: [],
    ...over,
  });
  const url = `http://localhost:7100/_render/page/${PAGE_ID}${query}`;
  return pageViewLoader({
    ...routerArgs(url, { headers: { cookie: 'cm_view=tok' } }),
    params: { pageId: PAGE_ID },
  });
}

async function refusal(over: Partial<Fakes>, query?: string): Promise<Response> {
  const thrown = await load(over, query).then(
    () => null,
    (error: unknown) => error
  );
  expect(thrown).toBeInstanceOf(Response);
  return thrown as Response;
}

test.describe('the render page loader (reader island)', () => {
  test('a staff payload: every locked body in, nothing per user, no comments, no downloads', async () => {
    const data = await load();
    expect(data.island.surface).toBe('render');
    expect(data.island.page).toEqual({ id: PAGE_ID, title: 'Week 1', width: 3, is_draft: true });
    const { payload } = data.island;
    const lock = payload.content.find(b => b.id === 'lock');
    expect(lock?.children).toHaveLength(1);
    expect(payload.readerSections).toEqual({
      staff: true,
      signedIn: false,
      canCheck: false,
      canUnlock: false,
      checked: [],
      unlocked: {},
    });
    expect(payload.signInUrl).toBeNull();
    expect('readerComments' in payload).toBe(false);
    expect(payload.mediaDownloads).toEqual({});
    expect(fakes.calls).not.toContain('comments');
    expect(fakes.calls).not.toContain('downloads');
    // The page's own visibility tier, as before.
    expect(fakes.calls).toContain('tier:false');
    // Assets: a ref and its map; the cover kept.
    expect(payload.coverImage).toEqual({ url: 'assets/cover.png', position: 20 });
    expect(payload.assets).toEqual({ 'assets/cover.png': 'https://cdn/cover.png?sig' });
    expect(data.assets).toEqual({
      dev: false,
      entry: '/assets/entry.js',
      css: ['/assets/r.css'],
      preloads: ['/assets/m.js'],
    });
    expect(data.meta).toEqual({ kind: 'page', version: 'sha-1' });
  });

  test('page links as the render always drew them: every page of this classroom it names, `#`, live title', async () => {
    const { payload } = (await load()).island;
    // Looked up in the page's own classroom only.
    expect(fakes.calls).toContain(
      `linked:${CLASS_ID}:${[DRAFT_LINKED, LINKED, OTHER_CLASS_PAGE, 'page-missing'].sort().join(',')}`
    );
    expect(payload.links).toEqual({
      [LINKED]: { href: '#', title: 'Live title', membersOnly: true },
      [DRAFT_LINKED]: { href: '#', title: 'Untitled', membersOnly: false },
    });
    const linkIds = payload.content.filter(b => b.type === 'pageLink').map(b => b.props.pageId);
    // Another classroom's page and a missing one are not drawn.
    expect(linkIds).toEqual([LINKED, DRAFT_LINKED]);
    // No schedule tile (the render never drew one).
    expect(payload.scheduleHref).toBeNull();
    const grid = payload.content.find(b => b.type === 'navGrid');
    expect(String(grid?.props.entries)).not.toContain('schedule');
  });

  test('the live document when the classroom edits live; git main when the room is unreachable', async () => {
    const live = await load({ collabEnabled: true });
    expect(fakes.calls.filter(c => c === 'snapshot' || c.startsWith('git:'))).toEqual(['snapshot']);
    expect(live.meta.version).toBe('live:2.9');
    // The snapshot has no cover in content: none is invented.
    expect(live.island.payload.coverImage).toBeNull();

    const fallback = await load({ collabEnabled: true, snapshot: 'fails' });
    expect(fakes.calls.filter(c => c === 'snapshot' || c.startsWith('git:'))).toEqual([
      'snapshot',
      'git:main',
    ]);
    expect(fallback.meta.version).toBe('sha-1');
  });

  test('the preview branch from git, never the live room; the token names the target', async () => {
    const data = await load({ collabEnabled: true }, '?at=preview&pin=sha-9');
    expect(fakes.calls.filter(c => c === 'snapshot' || c.startsWith('git:'))).toEqual([
      'git:preview/pages/week-1',
    ]);
    expect(fakes.calls).toContain('verify:preview:sha-9:4');
    expect(data.island.payload.content.find(b => b.id === 'lock')?.children).toHaveLength(1);
  });

  test('refused exactly as before: a legacy page, a bad token, an unknown page, a bad query', async () => {
    for (const response of [
      await refusal({ gitFormat: 'html' }),
      await refusal({ token: false }),
      await refusal({}, '?at=elsewhere&pin=head'),
    ]) {
      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe(VIEW_HEADERS['Cache-Control']);
      expect(await response.text()).toBe('Forbidden');
    }
    Object.assign(fakes, { calls: [] });
    const unknown = await pageViewLoader({
      ...routerArgs('http://localhost:7100/_render/page/nope?at=main&pin=head'),
      params: { pageId: 'nope' },
    }).catch((e: unknown) => e);
    expect((unknown as Response).status).toBe(403);
  });
});

test.describe('the render page CSP (its own, not the class site’s)', () => {
  const directivesOf = (csp: string) =>
    Object.fromEntries(
      csp.split('; ').map(part => {
        const [name, ...values] = part.split(' ');
        return [name, values.join(' ')];
      })
    );
  const FIXED = {
    'default-src': "'none'",
    'style-src': "'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src': "'self' https://fonts.gstatic.com data:",
    'img-src': "'self' https: data:",
    'media-src': "'self' https:",
    'frame-src': 'https:',
    'connect-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'none'",
    'frame-ancestors': "'none'",
  };

  test('a build: scripts only from this origin’s /assets/ and the dark-mode hash; no connections; never framed', () => {
    const csp = renderContentSecurityPolicy({ assetsOrigin: 'https://pages.classmoji.io' });
    expect(directivesOf(csp)).toEqual({
      ...FIXED,
      'script-src': `https://pages.classmoji.io/assets/ ${DARK_MODE_SCRIPT_HASH}`,
    });
    expect(csp).not.toContain("'self' 'sha");
    expect(csp).not.toContain('unsafe-eval');
  });

  test("dev (no assets origin): 'self', since Vite serves modules from other paths", () => {
    expect(directivesOf(renderContentSecurityPolicy())).toEqual({
      ...FIXED,
      'script-src': `'self' ${DARK_MODE_SCRIPT_HASH}`,
    });
  });

  test('the headers: view headers, nosniff and the policy', () => {
    expect(renderPageHeaders({ assetsOrigin: 'https://pages.classmoji.io' })).toEqual({
      ...VIEW_HEADERS,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': renderContentSecurityPolicy({
        assetsOrigin: 'https://pages.classmoji.io',
      }),
    });
  });
});

test.describe('the route: headers from the request’s origin, and no data requests', () => {
  let routeLoader: (args: unknown) => Promise<unknown>;
  test.beforeAll(async () => {
    ({ loader: routeLoader } = await importWithStubs<{ loader: typeof routeLoader }>(
      new URL('../../app/render/page.tsx', import.meta.url),
      {
        '/app/utils/pageView.server.ts': stubModule(
          "export const pageViewLoader = async () => { globalThis.__renderLoads = (globalThis.__renderLoads ?? 0) + 1; return { island: {}, assets: {}, meta: { kind: 'page', version: 'v' } }; };"
        ),
        '.css': stubModule('export default "";'),
      }
    ));
  });

  test('a page load: the data, with the build policy for the request’s own origin', async () => {
    const result = (await routeLoader({
      ...routerArgs('http://localhost:7100/_render/page/p1?at=main&pin=head'),
      params: { pageId: 'p1' },
    })) as { data: unknown; init: { headers: Record<string, string> } };
    expect(result.data).toEqual({ island: {}, assets: {}, meta: { kind: 'page', version: 'v' } });
    expect(result.init.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(result.init.headers['Content-Security-Policy']).toContain(
      `script-src http://localhost:7100/assets/ ${DARK_MODE_SCRIPT_HASH};`
    );
  });

  test('a `.data` request is a 404 before the page is read', async () => {
    const g = globalThis as { __renderLoads?: number };
    const before = g.__renderLoads ?? 0;
    const raw = 'http://localhost:7100/_render/page/p1.data?at=main&pin=head&_routes=render%2Fpage';
    const thrown = await routeLoader({ ...routerArgs(raw), params: { pageId: 'p1' } }).catch(
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect((thrown as Response).headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(g.__renderLoads ?? 0).toBe(before);
    expect(isRenderDataRequest(new Request(raw))).toBe(true);
    expect(isRenderDataRequest(new Request('http://localhost:7100/_render/page/p1?at=main'))).toBe(
      false
    );
    expect(renderDataRequestRefusal().status).toBe(404);
  });
});

test.describe('the document the root gives render paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../app/root.tsx'), 'utf-8');
  const start = source.indexOf('const RenderDocument');
  // Up to the next component's doc comment (SiteDocument's).
  const end = source.indexOf('/**', start);
  const renderDocument = source.slice(start, end);

  test('declares itself pending, inlines only the dark-mode script, and loads no bundle', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(renderDocument).toContain('[VIEW_PENDING_ATTRIBUTE]');
    expect(renderDocument.match(/dangerouslySetInnerHTML=\{\{ __html: (\w+) \}\}/g)).toEqual([
      'dangerouslySetInnerHTML={{ __html: DARK_MODE_SCRIPT }}',
    ]);
    expect(renderDocument).not.toContain('<Scripts');
    expect(renderDocument).not.toContain('<ScrollRestoration');
  });

  test('render paths get it, and only render paths; a data request for one is refused', () => {
    expect(source).toContain('const RENDER_PATH = /^\\/_render\\/page\\/[^/]+$/;');
    expect(source).toMatch(
      /if \(isRenderPath\(url\.pathname\)\) \{[^}]*if \(isRenderDataRequest\(request\)\) throw renderDataRequestRefusal\(\);\s*return \{ user: null, isSite: true, isRender: true \};/
    );
    expect(source).toContain(
      "if (data && 'isRender' in data && data.isRender) return <RenderDocument />;"
    );
  });
});
