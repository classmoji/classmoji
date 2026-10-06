/**
 * Page content tools in a classroom with live editing (collab_enabled):
 * reads come from the live document, `mode: 'live'` applies ops through the
 * collab server with a version check, the cover is written live, and a
 * preview is accepted through the collab server's merge-preview. The collab
 * internal HTTP API is a stubbed `fetch`; an unflagged classroom must never
 * reach it.
 *
 * `@classmoji/services` is mocked as in pageContent.test.ts, keeping the pure
 * block helpers (ensureBlockIds / applyBlockOps / previewBranchName) real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  pageFindById: vi.fn(),
  pageQuickUpdate: vi.fn(),
  loadPageContent: vi.fn(),
  savePageContent: vi.fn(),
  getPreviewStatus: vi.fn(),
  ensurePreviewBranch: vi.fn(),
  acceptPreview: vi.fn(),
  discardPreview: vi.fn(),
  resolvePageAssetUrl: vi.fn(),
  canonicalizePageCoverRef: vi.fn(),
  compareBranches: vi.fn(),
  userFindById: vi.fn(),
  auditCreate: vi.fn(),
  collabEnvMissing: { value: false },
}));

// The real env resolution (vitest is not production, so it yields the dev
// fallback), switchable to "not configured" for one test.
vi.mock('@classmoji/collab/env', async () => {
  const actual =
    await vi.importActual<typeof import('@classmoji/collab/env')>('@classmoji/collab/env');
  return {
    ...actual,
    resolveCollabEnv: (...a: Parameters<typeof actual.resolveCollabEnv>) =>
      mocks.collabEnvMissing.value ? null : actual.resolveCollabEnv(...a),
  };
});

// The page schema's round trip, stood in for: fills BlockNote's default
// props the way the live document does.
vi.mock('@classmoji/page-schema/server', () => {
  const fill = (blocks: unknown[]): unknown[] =>
    blocks.map(block => {
      const b = block as { props?: Record<string, unknown>; children?: unknown[] };
      return {
        ...b,
        props: { textColor: 'default', ...(b.props ?? {}) },
        children: fill(b.children ?? []),
      };
    });
  return {
    blocksToYDoc: (blocks: unknown[]) => blocks,
    yDocToBlocks: (doc: unknown[]) => fill(doc),
  };
});

vi.mock('../../../../../packages/services/src/content/ContentService.ts', () => ({
  ContentService: {},
}));

vi.mock('@classmoji/services', async () => {
  const pure = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/pageContent.service.ts')
  >('../../../../../packages/services/src/classmoji/pageContent.service.ts');
  return {
    validateFile: () => ({ valid: true }),
    ContentService: {
      compareBranches: (...a: unknown[]) => mocks.compareBranches(...a),
    },
    ClassmojiService: {
      page: {
        findById: (...a: unknown[]) => mocks.pageFindById(...a),
        quickUpdate: (...a: unknown[]) => mocks.pageQuickUpdate(...a),
      },
      user: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
      pageContent: {
        pageBlockOpSchema: pure.pageBlockOpSchema,
        previewBranchName: pure.previewBranchName,
        ensureBlockIds: pure.ensureBlockIds,
        applyBlockOps: pure.applyBlockOps,
        newColumnListIds: pure.newColumnListIds,
        LIVE_COLUMNS_REFUSED_MESSAGE: pure.LIVE_COLUMNS_REFUSED_MESSAGE,
        loadPageContent: (...a: unknown[]) => mocks.loadPageContent(...a),
        savePageContent: (...a: unknown[]) => mocks.savePageContent(...a),
        getPreviewStatus: (...a: unknown[]) => mocks.getPreviewStatus(...a),
        ensurePreviewBranch: (...a: unknown[]) => mocks.ensurePreviewBranch(...a),
        acceptPreview: (...a: unknown[]) => mocks.acceptPreview(...a),
        discardPreview: (...a: unknown[]) => mocks.discardPreview(...a),
        resolvePageAssetUrl: (...a: unknown[]) => mocks.resolvePageAssetUrl(...a),
        canonicalizePageCoverRef: (...a: unknown[]) => mocks.canonicalizePageCoverRef(...a),
      },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
  };
});

const {
  pageContentOutlineTool,
  pageContentGetTool,
  pageContentApplyTool,
  pageCoverSetTool,
  pagePreviewAcceptTool,
  pagePreviewDiscardTool,
  pageAssetUploadTool,
} = await import('../pageContent.ts');

const CTX: ToolContext = {
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const PREVIEW_BRANCH = 'preview/pages/syllabus';

const CLASSROOM = {
  id: 'class-1',
  slug: 'cs101',
  content_repo: 'content-test-org-cs101',
  git_organization: { provider: 'GITHUB', login: 'test-org' },
};

/** A published page in a classroom that edits live. */
const LIVE_PAGE = {
  id: PAGE_ID,
  classroom_id: 'class-1',
  title: 'Syllabus',
  slug: 'syllabus',
  content_path: 'pages/syllabus',
  is_draft: false,
  classroom: { ...CLASSROOM, collab_enabled: true },
};
const LIVE_DRAFT = { ...LIVE_PAGE, is_draft: true };
/** The same pages with the flag off: today's behaviour. */
const PLAIN_PAGE = { ...LIVE_PAGE, classroom: { ...CLASSROOM, collab_enabled: false } };
const PLAIN_DRAFT = { ...PLAIN_PAGE, is_draft: true };

const LIVE_BLOCKS = () => [
  { id: 'h1', type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'Week 1' }] },
  { id: 'p1', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Read chapter 1' }] },
];

const COVER = { url: 'pages/syllabus/assets/hero.png', position: 40 };

// ─── Stubbed collab internal API ─────────────────────────────────────────────

interface CollabCall {
  method: string;
  path: string;
  /** The query string (`?viewer=…` on an agent's read). */
  search: string;
  secret: string | null;
  body: Record<string, unknown> | null;
}

type Responder = (call: CollabCall) => { status: number; body: unknown } | 'network-error';

let calls: CollabCall[] = [];
let routes: Record<string, Responder> = {};

function route(method: string, action: string, responder: Responder) {
  routes[`${method} ${action}`] = responder;
}

function snapshotResponder(version = 7, coverImage: unknown = null): Responder {
  return () => ({
    status: 200,
    body: { epoch: 1, version, live: true, content: { blocks: LIVE_BLOCKS(), coverImage } },
  });
}

const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const parsed = new URL(String(url));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const call: CollabCall = {
    method: init?.method ?? 'GET',
    path: parsed.pathname,
    search: parsed.search,
    secret: headers['x-collab-secret'] ?? null,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  };
  calls.push(call);
  const action = parsed.pathname.split('/').pop();
  const responder = routes[`${call.method} ${action}`];
  const result = responder ? responder(call) : { status: 404, body: { error: 'not-found' } };
  if (result === 'network-error') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
});

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset();
  mocks.collabEnvMissing.value = false;
  calls = [];
  routes = {};
  fakeFetch.mockClear();
  vi.stubGlobal('fetch', fakeFetch);
  mocks.pageFindById.mockResolvedValue(LIVE_DRAFT);
  mocks.getPreviewStatus.mockResolvedValue({ exists: false });
  mocks.loadPageContent.mockResolvedValue({
    format: 'json',
    blocks: LIVE_BLOCKS(),
    coverImage: null,
    sha: 'git-sha-1',
  });
  mocks.savePageContent.mockResolvedValue({
    sha: 'new-sha',
    commit: 'commit-sha',
    coverImage: null,
  });
  mocks.ensurePreviewBranch.mockResolvedValue({ branch: PREVIEW_BRANCH, created: true });
  mocks.userFindById.mockResolvedValue({ id: 'teacher-1', name: 'Ada Lovelace' });
  mocks.resolvePageAssetUrl.mockResolvedValue('https://signed.example/hero.png');
  mocks.canonicalizePageCoverRef.mockImplementation(async (_page, url: string) => url);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.pageQuickUpdate.mockResolvedValue(undefined);
  mocks.discardPreview.mockResolvedValue({ existed: true });
  route('GET', 'snapshot', snapshotResponder());
  route('POST', 'ops', () => ({ status: 200, body: { version: 8 } }));
  route('POST', 'cover', () => ({ status: 200, body: { version: 9 } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const UPDATE_OP = {
  op: 'update' as const,
  id: 'p1',
  block: { type: 'paragraph', content: [{ type: 'text', text: 'Read chapters 1–2' }] },
};

// ─── Unflagged classrooms ────────────────────────────────────────────────────

describe('unflagged classroom', () => {
  it('reads, applies, sets the cover and accepts without ever calling the collab server', async () => {
    mocks.pageFindById.mockResolvedValue(PLAIN_DRAFT);
    const outline = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(outline.sha).toBe('git-sha-1');
    expect(outline.sha_source).toBe('content_json');
    expect(outline).not.toHaveProperty('version');

    const applied = parse(
      await pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'git-sha-1', ops: [UPDATE_OP] },
        CTX
      )
    );
    expect(applied).toMatchObject({ success: true, new_sha: 'new-sha', committed_to: 'main' });

    mocks.loadPageContent.mockResolvedValue({
      format: 'json',
      blocks: LIVE_BLOCKS(),
      coverImage: COVER,
      sha: 'git-sha-1',
    });
    await pageCoverSetTool.handler({ classroom: 'org/x', page_id: PAGE_ID, position: 10 }, CTX);
    expect(mocks.savePageContent).toHaveBeenCalledTimes(2);

    mocks.getPreviewStatus.mockResolvedValue({ exists: true });
    mocks.acceptPreview.mockResolvedValue({ merged: true, sha: 'merged-sha' });
    await pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX);
    expect(mocks.acceptPreview).toHaveBeenCalledTimes(1);

    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("maps mode: 'live' to a direct commit and mode: 'preview' to the preview branch", async () => {
    mocks.pageFindById.mockResolvedValue(PLAIN_PAGE);
    const live = parse(
      await pageContentApplyTool.handler(
        {
          classroom: 'org/x',
          page_id: PAGE_ID,
          expected_sha: 'git-sha-1',
          ops: [UPDATE_OP],
          mode: 'live',
        },
        CTX
      )
    );
    expect(live.committed_to).toBe('main');
    expect(mocks.savePageContent.mock.calls[0][2]).not.toHaveProperty('branch');

    mocks.pageFindById.mockResolvedValue(PLAIN_DRAFT);
    const preview = parse(
      await pageContentApplyTool.handler(
        {
          classroom: 'org/x',
          page_id: PAGE_ID,
          expected_sha: 'git-sha-1',
          ops: [UPDATE_OP],
          mode: 'preview',
        },
        CTX
      )
    );
    expect(preview.committed_to).toBe('preview');
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe('flagged classroom without the collab env', () => {
  it('reads fall back to git, labelled; live writes are refused', async () => {
    mocks.collabEnvMissing.value = true;
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outline = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(outline).toMatchObject({ sha: 'git-sha-1', live_unavailable: true });
    expect(outline.note).toMatch(/not configured/);
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'git-sha-1', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'LIVE_UNAVAILABLE' });
    await expect(
      pageCoverSetTool.handler({ classroom: 'org/x', page_id: PAGE_ID, position: 10 }, CTX)
    ).rejects.toMatchObject({ code: 'LIVE_UNAVAILABLE' });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
    expect(fakeFetch).not.toHaveBeenCalled();
    silence.mockRestore();
  });
});

// ─── Reads ───────────────────────────────────────────────────────────────────

describe('live reads', () => {
  it('outline reads the live document and reports its version', async () => {
    const result = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(result).toMatchObject({
      sha: 'live:1.7',
      sha_source: 'live',
      version: 7,
      live: { open_now: true },
      block_count: 2,
    });
    expect(result.blocks.map((b: { id: string }) => b.id)).toEqual(['h1', 'p1']);
    expect(mocks.loadPageContent).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: `/internal/page/${PAGE_ID}/snapshot`,
      // An agent's read: the live service remembers it for the agent's pin.
      search: '?viewer=teacher-1',
      secret: expect.any(String),
    });
  });

  it("a render reads with no viewer, so a picture never counts as the agent's read", async () => {
    const { readPageForRender } = await import('../pageRender.ts');
    const read = await readPageForRender(LIVE_DRAFT as never, 'main');
    expect(read.version).toBe('live:1.7');
    expect(calls.map(call => call.search)).toEqual(['']);
  });

  it("names the agent session on a read, so each session's pin is its own", async () => {
    const SESSION_CTX = {
      ...CTX,
      viewer: { ...CTX.viewer, agentSession: 'sess-1' },
    } as typeof CTX;
    await pageContentGetTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, SESSION_CTX);
    expect(calls[0].search).toBe('?viewer=teacher-1&session=sess-1');
  });

  it.each([
    [409, 'unreadable-live-doc', 'LIVE_UNREADABLE'],
    [400, 'something-new', 'LIVE_READ_FAILED'],
  ])('maps a %s %s on a read to a clear agent error', async (status, error, code) => {
    route('GET', 'snapshot', () => ({ status, body: { error } }));
    await expect(
      pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    ).rejects.toMatchObject({ code });
  });

  it('get returns selected live blocks with the version', async () => {
    const result = parse(
      await pageContentGetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, block_ids: ['p1'] },
        CTX
      )
    );
    expect(result).toMatchObject({ sha: 'live:1.7', version: 7, block_count: 2 });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].id).toBe('p1');
  });

  it('falls back to git and says so when the collab server is unreachable', async () => {
    route('GET', 'snapshot', () => 'network-error');
    const result = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(result.sha).toBe('git-sha-1');
    expect(result.live_unavailable).toBe(true);
    expect(result.note).toMatch(/did not answer/);
    expect(mocks.loadPageContent).toHaveBeenCalledTimes(1);
  });

  it("at: 'preview' still reads the preview branch from git", async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true });
    await pageContentGetTool.handler({ classroom: 'org/x', page_id: PAGE_ID, at: 'preview' }, CTX);
    expect(mocks.loadPageContent.mock.calls[0][1]).toMatchObject({ ref: PREVIEW_BRANCH });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

// ─── page_content_apply ──────────────────────────────────────────────────────

describe('live apply', () => {
  it('a draft defaults to live: ops go to the collab server as the caller', async () => {
    const result = parse(
      await pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [UPDATE_OP] },
        CTX
      )
    );
    expect(result).toMatchObject({
      success: true,
      new_sha: 'live:1.8',
      version: 8,
      committed_to: 'live',
      block_count: 2,
    });
    const post = calls.find(call => call.method === 'POST');
    expect(post).toMatchObject({
      path: `/internal/page/${PAGE_ID}/ops`,
      body: { ops: [UPDATE_OP], actor: { userId: 'teacher-1', name: 'Ada Lovelace' } },
    });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
    expect(mocks.auditCreate.mock.calls[0][0].data).toMatchObject({
      committed_to: 'live',
      new_sha: 'live:1.8',
      // Distinct per write, so the audit's 5 s dedupe never merges two applies.
      value: 'live:1.8',
    });
  });

  it('accepts a bare version number as expected_sha', async () => {
    const result = parse(
      await pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: '7', ops: [UPDATE_OP] },
        CTX
      )
    );
    expect(result.committed_to).toBe('live');
  });

  it('an older version-only pin is judged in the current epoch', async () => {
    route('GET', 'snapshot', snapshotResponder(12));
    await pageContentApplyTool.handler(
      { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:7', ops: [UPDATE_OP] },
      CTX
    );
    const post = calls.find(call => call.method === 'POST');
    expect(post?.body?.expect_since).toEqual({ epoch: 1, version: 7 });
  });

  it('refuses a git sha in live mode, naming the read that gives a version', async () => {
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'git-sha-1', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      message: expect.stringMatching(/live version.*page_content_get/),
    });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("commit: 'direct' means live, never a write to git main", async () => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    const result = parse(
      await pageContentApplyTool.handler(
        {
          classroom: 'org/x',
          page_id: PAGE_ID,
          expected_sha: 'live:1.7',
          ops: [UPDATE_OP],
          commit: 'direct',
        },
        CTX
      )
    );
    expect(result.committed_to).toBe('live');
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('reports an unknown block id before sending anything', async () => {
    await expect(
      pageContentApplyTool.handler(
        {
          classroom: 'org/x',
          page_id: PAGE_ID,
          expected_sha: 'live:1.7',
          ops: [{ op: 'delete', id: 'nope' }],
        },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('says the live service is down rather than writing git', async () => {
    route('POST', 'ops', () => 'network-error');
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'LIVE_UNAVAILABLE' });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });
});

describe('pinned live applies (live:<epoch>.<version>)', () => {
  /** The live page at `epoch.version` with `blocks`. */
  const serve = (version: number, blocks: unknown[], epoch = 1) =>
    route('GET', 'snapshot', () => ({
      status: 200,
      body: { epoch, version, live: true, content: { blocks, coverImage: null } },
    }));
  const readOutline = () =>
    pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX);
  const apply = (ops: unknown[], expected_sha?: string) =>
    pageContentApplyTool.handler(
      {
        classroom: 'org/x',
        page_id: PAGE_ID,
        ...(expected_sha ? { expected_sha } : {}),
        ops: ops as never,
      },
      CTX
    );
  const posted = () => calls.filter(call => call.method === 'POST');
  const INSERT_OP = {
    op: 'insert',
    blocks: [{ id: 'new1', type: 'paragraph', content: [] }],
    position: { at: 'end' },
  };

  it('reads report the epoch-qualified pin', async () => {
    serve(7, LIVE_BLOCKS(), 3);
    const outline = parse(await readOutline());
    expect(outline).toMatchObject({ sha: 'live:3.7', epoch: 3, version: 7 });
  });

  it('sends the pin as expect_since: the live service judges it per block', async () => {
    serve(15, LIVE_BLOCKS());
    const result = parse(await apply([UPDATE_OP], 'live:1.7'));
    expect(result).toMatchObject({ success: true, new_sha: 'live:1.8' });
    const [post] = posted();
    expect(post.body).toMatchObject({ expect_since: { epoch: 1, version: 7 } });
    expect(post.body).not.toHaveProperty('expect');
    expect(post.body).not.toHaveProperty('remember');
    // The apply's own pre-read is not an agent read: no viewer, nothing remembered.
    const pre = calls.find(call => call.method === 'GET');
    expect(pre?.search).toBe('');
  });

  it('keeps no state: a read on another MCP machine and an apply here work alike', async () => {
    // No read through this process at all; the version moved on since.
    serve(42, LIVE_BLOCKS());
    route('POST', 'ops', () => ({ status: 200, body: { epoch: 1, version: 43 } }));
    expect(parse(await apply([UPDATE_OP], 'live:1.7')).new_sha).toBe('live:1.43');
    expect(posted()[0].body?.expect_since).toEqual({ epoch: 1, version: 7 });
  });

  it("maps the server's unknown-version to CONTENT_CONFLICT unknown-pin (re-read)", async () => {
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'unknown-version', current: { epoch: 1, version: 15 } },
    }));
    await expect(apply([UPDATE_OP], 'live:1.7')).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      data: { reason: 'unknown-pin', current_sha: 'live:1.15' },
      message: expect.stringMatching(/'live:1.7'.*it is now 'live:1.15'.*Re-read/),
    });
  });

  it("maps the server's stale-epoch to CONTENT_CONFLICT reloaded", async () => {
    route('POST', 'ops', () => ({ status: 409, body: { error: 'stale-epoch' } }));
    await expect(apply([UPDATE_OP], 'live:1.7')).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      data: { reason: 'reloaded' },
    });
  });

  it('refuses a pin from before the page was reloaded from git before sending anything', async () => {
    serve(7, LIVE_BLOCKS(), 2);
    await expect(apply([UPDATE_OP], 'live:1.7')).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      message: expect.stringMatching(/reloaded from git/),
    });
    expect(posted()).toHaveLength(0);
  });

  it('a pure insert without a pin asks the server to remember the new view', async () => {
    serve(15, LIVE_BLOCKS());
    route('POST', 'ops', () => ({
      status: 200,
      body: { epoch: 1, version: 16, insertedIds: ['new1'] },
    }));
    const inserted = parse(await apply([INSERT_OP]));
    expect(inserted.new_sha).toBe('live:1.16');
    expect(posted()[0].body).toMatchObject({ remember: true });
    expect(posted()[0].body).not.toHaveProperty('expect_since');
  });

  it('pure inserts may omit expected_sha', async () => {
    serve(15, LIVE_BLOCKS());
    const result = parse(await apply([INSERT_OP]));
    expect(result.committed_to).toBe('live');
    expect(posted()).toHaveLength(1);
  });

  it.each([
    ['update', [UPDATE_OP]],
    ['delete', [{ op: 'delete', id: 'p1' }]],
    ['move', [{ op: 'move', id: 'p1', position: { at: 'start' } }]],
    ['replace_all', [{ op: 'replace_all', blocks: LIVE_BLOCKS() }]],
  ])('%s without expected_sha is refused before anything is sent', async (_name, ops) => {
    await expect(apply(ops)).rejects.toMatchObject({ code: 'EXPECTED_SHA_REQUIRED' });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('still requires expected_sha outside live mode', async () => {
    mocks.pageFindById.mockResolvedValue(PLAIN_DRAFT);
    await expect(apply([UPDATE_OP])).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });
});

describe('guarded ops, inserted ids and save status', () => {
  const serve = (version: number, blocks: unknown[], extra: Record<string, unknown> = {}) =>
    route('GET', 'snapshot', () => ({
      status: 200,
      body: { epoch: 1, version, live: true, content: { blocks, coverImage: null }, ...extra },
    }));
  const readOutline = () =>
    pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX);
  const apply = (ops: unknown[], expected_sha?: string) =>
    pageContentApplyTool.handler(
      {
        classroom: 'org/x',
        page_id: PAGE_ID,
        ...(expected_sha ? { expected_sha } : {}),
        ops: ops as never,
      },
      CTX
    );

  it("maps the server's 409 block-changed to BLOCK_CHANGED with its ids", async () => {
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'block-changed', changedIds: ['p1'] },
    }));
    await expect(apply([UPDATE_OP], 'live:1.7')).rejects.toMatchObject({
      code: 'BLOCK_CHANGED',
      data: { changed_ids: ['p1'] },
    });
  });

  it("reports the live page's ids for inserted blocks", async () => {
    serve(7, LIVE_BLOCKS());
    await readOutline();
    route('POST', 'ops', () => ({
      status: 200,
      body: { epoch: 1, version: 8, insertedIds: ['srv1'] },
    }));
    const insert = {
      op: 'insert',
      blocks: [{ type: 'paragraph', content: [] }],
      position: { at: 'end' },
    };
    const first = parse(await apply([insert], 'live:1.7'));
    expect(first.applied[0]).toMatchObject({ op: 'insert', count: 1, ids: ['srv1'] });
    expect(first.new_sha).toBe('live:1.8');
  });

  it('live reads say when the page last reached GitHub and why it did not', async () => {
    serve(7, LIVE_BLOCKS(), {
      lastCheckpointAt: '2026-10-03T21:00:00.000Z',
      lastCheckpointError: 'push rejected',
    });
    const outline = parse(await readOutline());
    expect(outline).toMatchObject({
      saved_to_github_at: '2026-10-03T21:00:00.000Z',
      save_error: 'push rejected',
    });
  });
});

describe('preview-changed notifications', () => {
  const notified = () =>
    calls.filter(call => call.method === 'POST' && call.path.endsWith('/preview-changed'));

  beforeEach(() => {
    route('POST', 'preview-changed', () => ({ status: 200, body: { broadcast: 1 } }));
  });

  it('a preview apply tells open editors', async () => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    await pageContentApplyTool.handler(
      { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [UPDATE_OP] },
      CTX
    );
    expect(notified()).toHaveLength(1);
    expect(notified()[0]).toMatchObject({
      path: `/internal/page/${PAGE_ID}/preview-changed`,
      body: {},
      secret: expect.any(String),
    });
  });

  it('a discard tells open editors, and a failed notice does not fail the discard', async () => {
    route('POST', 'preview-changed', () => ({ status: 500, body: { error: 'internal-error' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parse(
      await pagePreviewDiscardTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(result.discarded).toBe(true);
    expect(notified()).toHaveLength(1);
    warn.mockRestore();
  });

  it('an unflagged classroom is never notified', async () => {
    mocks.pageFindById.mockResolvedValue(PLAIN_PAGE);
    await pagePreviewDiscardTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX);
    await pageContentApplyTool.handler(
      { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'git-sha-1', ops: [UPDATE_OP] },
      CTX
    );
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('a live accept tells open editors', async () => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    mocks.getPreviewStatus.mockResolvedValue({ exists: true });
    mocks.compareBranches.mockResolvedValue({ merge_base_sha: 'base-commit', head_sha: 'h1' });
    route('POST', 'merge-preview', () => ({ status: 200, body: { applied: true, version: 11 } }));
    await pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX);
    expect(notified()).toHaveLength(1);
  });
});

describe('live write refusals', () => {
  it.each([
    [409, 'collab-disabled', 'LIVE_DISABLED', /turned off.*Re-read/],
    [413, 'body-too-large', 'PAYLOAD_TOO_LARGE', /too large.*Split/],
  ])('%s %s is a clear agent error', async (status, error, code, message) => {
    route('POST', 'ops', () => ({ status, body: { error } }));
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
  });

  it('postOps refuses a missing pin argument instead of defaulting', async () => {
    const { postOps } = await import('../../collab/client.ts');
    expect(() =>
      postOps(
        { httpUrl: 'http://x', secret: 's' } as never,
        'page',
        'p',
        [],
        CTX as never,
        undefined as never
      )
    ).toThrow(/pass the pin/);
  });

  it.each([
    [409, 'content-missing'],
    [422, 'legacy-html'],
  ])('%s %s points the agent at preview mode', async (status, code) => {
    route('POST', 'ops', () => ({ status, body: { error: code } }));
    const error = await pageContentApplyTool
      .handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [UPDATE_OP] },
        CTX
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'LIVE_UNSUPPORTED' });
    expect((error as Error).message).toMatch(/mode: 'preview'/);
  });
});

describe('new column layouts on a live page', () => {
  const COLUMNS_OP = {
    op: 'insert' as const,
    blocks: [
      {
        id: 'cols',
        type: 'columnList',
        children: [
          { id: 'c1', type: 'column', children: [{ id: 'l', type: 'paragraph' }] },
          { id: 'c2', type: 'column', children: [{ id: 'r', type: 'paragraph' }] },
        ],
      },
    ],
    position: { at: 'end' as const },
  };

  it("maps the server's columns-not-allowed-live to COLUMNS_NOT_ALLOWED_LIVE", async () => {
    route('POST', 'ops', () => ({
      status: 422,
      body: {
        error: 'columns-not-allowed-live',
        message: "Column layouts can't be added to a page with live editing on.",
        ids: ['cols'],
      },
    }));
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [COLUMNS_OP] },
        CTX
      )
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'COLUMNS_NOT_ALLOWED_LIVE',
      message: expect.stringMatching(/live editing on.*Nothing was changed/),
      data: { ids: ['cols'] },
    });
  });

  it('a preview accept refused for a new layout says so, without a retry hint', async () => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    mocks.getPreviewStatus.mockResolvedValue({ exists: true });
    mocks.compareBranches.mockResolvedValue({ merge_base_sha: 'base-commit', head_sha: 'h1' });
    route('POST', 'merge-preview', () => ({
      status: 422,
      body: { error: 'columns-not-allowed-live', message: 'No new column layouts.', ids: ['x'] },
    }));
    const error = await pagePreviewAcceptTool
      .handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'COLUMNS_NOT_ALLOWED_LIVE' });
    expect((error as Error).message).not.toMatch(/Retry/);
    expect(mocks.discardPreview).not.toHaveBeenCalled();
  });

  it('a preview of a live page refuses a new layout before writing anything', async () => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [COLUMNS_OP] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'COLUMNS_NOT_ALLOWED_LIVE', data: { ids: ['cols'] } });
    expect(mocks.ensurePreviewBranch).not.toHaveBeenCalled();
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('a page without live editing takes a new layout as before', async () => {
    mocks.pageFindById.mockResolvedValue(PLAIN_PAGE);
    const result = parse(
      await pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'git-sha-1', ops: [COLUMNS_OP] },
        CTX
      )
    );
    expect(result.success).toBe(true);
    expect(mocks.savePageContent).toHaveBeenCalledTimes(1);
  });
});

describe('preview mode with live editing', () => {
  it('a published page defaults to preview, cut from main, taking the live version', async () => {
    vi.stubEnv('PAGES_URL', 'https://pages.example.test/');
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    const result = parse(
      await pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [UPDATE_OP] },
        CTX
      )
    );
    expect(result.committed_to).toBe('preview');
    expect(result.preview_url).toBe(`https://pages.example.test/cs101/${PAGE_ID}?preview=1`);
    expect(mocks.ensurePreviewBranch).toHaveBeenCalledTimes(1);
    // The CAS is on the sha actually loaded from main.
    expect(mocks.savePageContent.mock.calls[0][2]).toMatchObject({
      expectedSha: 'git-sha-1',
      branch: PREVIEW_BRANCH,
    });
    // Nothing goes into the live document (only the preview notice is posted).
    expect(calls.some(call => call.path.endsWith('/ops'))).toBe(false);
  });

  it('stacking onto an existing preview needs the preview sha, not a live version', async () => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    mocks.getPreviewStatus.mockResolvedValue({ exists: true });
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:1.7', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      message: expect.stringMatching(/preview/),
    });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });
});

// ─── page_cover_set ──────────────────────────────────────────────────────────

describe('live cover', () => {
  it('writes the cover through collab /cover, keeping the current position', async () => {
    route('GET', 'snapshot', snapshotResponder(7, COVER));
    const result = parse(
      await pageCoverSetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, url: 'pages/syllabus/assets/new.png' },
        CTX
      )
    );
    expect(result).toMatchObject({
      success: true,
      new_sha: 'live:1.9',
      cover_image: { url: 'pages/syllabus/assets/new.png', position: 40 },
    });
    expect(calls.find(call => call.method === 'POST')).toMatchObject({
      path: `/internal/page/${PAGE_ID}/cover`,
      body: {
        coverImage: { url: 'pages/syllabus/assets/new.png', position: 40 },
        actor: { userId: 'teacher-1', name: 'Ada Lovelace' },
      },
    });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
    expect(mocks.pageQuickUpdate).toHaveBeenCalledTimes(1);
    // A cover set vouches for no block: nothing is remembered for its new_sha.
    expect(calls.find(call => call.method === 'POST')?.body).not.toHaveProperty('remember');
    expect(mocks.auditCreate.mock.calls[0][0].data).toMatchObject({
      tool: 'page_cover_set',
      value: 'live:1.9',
    });
  });

  it('an unchanged cover sends nothing', async () => {
    route('GET', 'snapshot', snapshotResponder(7, COVER));
    const result = parse(
      await pageCoverSetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, url: COVER.url, position: 40 },
        CTX
      )
    );
    expect(result.unchanged).toBe(true);
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });
});

// ─── page_preview_accept ─────────────────────────────────────────────────────

describe('live preview accept', () => {
  const BASE_BLOCKS = LIVE_BLOCKS();
  const PREVIEW_BLOCKS = [
    LIVE_BLOCKS()[0],
    { id: 'p1', type: 'paragraph', content: [{ type: 'text', text: 'Read chapters 1–3' }] },
  ];

  beforeEach(() => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    mocks.getPreviewStatus.mockResolvedValue({ exists: true });
    mocks.compareBranches.mockResolvedValue({ merge_base_sha: 'base-commit', ahead_by: 1 });
    mocks.loadPageContent.mockImplementation(async (_page, options: { ref?: string }) =>
      options?.ref === PREVIEW_BRANCH
        ? { format: 'json', blocks: PREVIEW_BLOCKS, coverImage: COVER, sha: 'preview-sha' }
        : { format: 'json', blocks: BASE_BLOCKS, coverImage: null, sha: 'base-sha' }
    );
  });

  it('merges through collab /merge-preview, then deletes the preview branch', async () => {
    route('POST', 'merge-preview', () => ({ status: 200, body: { applied: true, version: 11 } }));
    const result = parse(
      await pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(result).toMatchObject({
      success: true,
      merged: true,
      committed_to: 'live',
      version: 11,
    });
    const post = calls.find(call => call.method === 'POST');
    expect(post?.path).toBe(`/internal/page/${PAGE_ID}/merge-preview`);
    expect(post?.body).toMatchObject({
      base: { blocks: BASE_BLOCKS, coverImage: null },
      theirs: { blocks: PREVIEW_BLOCKS, coverImage: COVER },
      actor: { userId: 'teacher-1', name: 'Ada Lovelace' },
    });
    expect(post?.body).not.toHaveProperty('resolutions');
    expect(mocks.loadPageContent.mock.calls.map(call => call[1].ref).sort()).toEqual(
      ['base-commit', PREVIEW_BRANCH].sort()
    );
    expect(mocks.discardPreview).toHaveBeenCalledTimes(1);
    expect(mocks.acceptPreview).not.toHaveBeenCalled();
  });

  it('keeps the preview when it gained commits during the accept', async () => {
    route('POST', 'merge-preview', () => ({ status: 200, body: { applied: true, version: 11 } }));
    mocks.compareBranches
      .mockResolvedValueOnce({ merge_base_sha: 'base-commit', head_sha: 'head-1', ahead_by: 1 })
      .mockResolvedValueOnce({ merge_base_sha: 'base-commit', head_sha: 'head-2', ahead_by: 2 });
    const result = parse(
      await pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(result).toMatchObject({ merged: true, preview_kept: true });
    expect(result.message).toMatch(/kept/);
    expect(mocks.discardPreview).not.toHaveBeenCalled();
  });

  it('a conflict returns the report, applies nothing and keeps the preview', async () => {
    const conflicts = [
      { id: 'p1', reason: 'content', base: BASE_BLOCKS[1], ours: {}, theirs: PREVIEW_BLOCKS[1] },
    ];
    route('POST', 'merge-preview', () => ({
      status: 409,
      body: { error: 'conflicts', conflicts },
    }));
    const result = parse(
      await pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(result).toMatchObject({
      conflict: true,
      units: conflicts,
      ours_sha: 'live',
      theirs_sha: 'preview-sha',
    });
    expect(result.message).toMatch(/resolutions/);
    expect(mocks.discardPreview).not.toHaveBeenCalled();
  });

  it('passes resolutions through and refuses a preview that moved since the report', async () => {
    route('POST', 'merge-preview', () => ({ status: 200, body: { applied: true, version: 12 } }));
    await pagePreviewAcceptTool.handler(
      {
        classroom: 'org/x',
        page_id: PAGE_ID,
        resolutions: [{ id: 'p1', choose: 'theirs' }],
        expected_theirs_sha: 'preview-sha',
      },
      CTX
    );
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({
      resolutions: [{ id: 'p1', choose: 'theirs' }],
    });

    calls = [];
    await expect(
      pagePreviewAcceptTool.handler(
        {
          classroom: 'org/x',
          page_id: PAGE_ID,
          resolutions: [{ id: 'p1', choose: 'theirs' }],
          expected_theirs_sha: 'older-preview-sha',
        },
        CTX
      )
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('keeps the preview when the merge fails', async () => {
    route('POST', 'merge-preview', () => ({ status: 500, body: { error: 'internal-error' } }));
    await expect(
      pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    ).rejects.toMatchObject({ code: 'LIVE_UNAVAILABLE' });
    expect(mocks.discardPreview).not.toHaveBeenCalled();
  });

  it('refuses a preview whose merge base cannot be read', async () => {
    mocks.compareBranches.mockResolvedValue({ merge_base_sha: null, ahead_by: 1 });
    await expect(
      pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });
});

// ─── Descriptions ────────────────────────────────────────────────────────────

describe('tool descriptions', () => {
  const tools = [
    pageContentOutlineTool,
    pageContentGetTool,
    pageContentApplyTool,
    pagePreviewAcceptTool,
    pagePreviewDiscardTool,
    pageAssetUploadTool,
    pageCoverSetTool,
  ];

  it('stay under the 1,500 UTF-8 bytes a client will keep', () => {
    for (const tool of tools) {
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
  });

  it('explain live vs preview and steer big edits to preview', () => {
    expect(pageContentApplyTool.description).toMatch(/mode: 'live'/);
    expect(pageContentApplyTool.description).toMatch(/rendered page/);
    expect(pageContentApplyTool.description).toMatch(/big edits/);
    expect(pageContentApplyTool.description).toMatch(/can't gain a new column layout/);
  });
});
