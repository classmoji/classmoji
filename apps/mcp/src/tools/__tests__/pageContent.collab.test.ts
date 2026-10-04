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

const { clearSnapshotCache } = await import('../../collab/liveCheck.ts');

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
  clearSnapshotCache();
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
  it('keeps the git paths, like the web apps, and never calls fetch', async () => {
    mocks.collabEnvMissing.value = true;
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outline = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(outline.sha).toBe('git-sha-1');
    const applied = parse(
      await pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'git-sha-1', ops: [UPDATE_OP] },
        CTX
      )
    );
    expect(applied.committed_to).toBe('main');
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
      sha: 'live:7',
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
      secret: expect.any(String),
    });
  });

  it('get returns selected live blocks with the version', async () => {
    const result = parse(
      await pageContentGetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, block_ids: ['p1'] },
        CTX
      )
    );
    expect(result).toMatchObject({ sha: 'live:7', version: 7, block_count: 2 });
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
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:7', ops: [UPDATE_OP] },
        CTX
      )
    );
    expect(result).toMatchObject({
      success: true,
      new_sha: 'live:8',
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
      new_sha: 'live:8',
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

  it('refuses a stale version with CONTENT_CONFLICT and sends nothing', async () => {
    route('GET', 'snapshot', snapshotResponder(12));
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:7', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      message: expect.stringMatching(/you read 'live:7', it is now 'live:12'.*mode: 'preview'/),
    });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
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
          expected_sha: 'live:7',
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
          expected_sha: 'live:7',
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
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:7', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'LIVE_UNAVAILABLE' });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });
});

describe('per-block staleness check', () => {
  /** The live page at `version` with `blocks`. */
  const serve = (version: number, blocks: unknown[]) =>
    route('GET', 'snapshot', () => ({
      status: 200,
      body: { epoch: 1, version, live: true, content: { blocks, coverImage: null } },
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

  it('applies when the targeted block is unchanged though others were edited since', async () => {
    serve(7, LIVE_BLOCKS());
    await readOutline();
    const typed = LIVE_BLOCKS();
    typed[0].content = [{ type: 'text', text: 'Week 1 (someone is typing here)' }];
    // Defaults filled in by the live document are not a change.
    serve(15, [typed[0], { ...LIVE_BLOCKS()[1], props: { textAlignment: 'left' } }]);
    const result = parse(await apply([UPDATE_OP], 'live:7'));
    expect(result).toMatchObject({ success: true, committed_to: 'live' });
    expect(posted()).toHaveLength(1);
  });

  it('refuses with BLOCK_CHANGED, naming the block, when the target was edited', async () => {
    serve(7, LIVE_BLOCKS());
    await readOutline();
    const edited = LIVE_BLOCKS();
    edited[1].content = [{ type: 'text', text: 'Read chapter 1 and 2' }];
    serve(15, edited);
    const error = await apply([UPDATE_OP], 'live:7').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BLOCK_CHANGED', data: { changed_ids: ['p1'] } });
    expect((error as Error).message).toMatch(/'p1'.*Re-read.*mode: 'preview'/);
    expect(posted()).toHaveLength(0);
  });

  it('refuses an insert whose anchor was deleted since the read', async () => {
    serve(7, LIVE_BLOCKS());
    await readOutline();
    serve(15, [LIVE_BLOCKS()[0]]);
    const insert = {
      op: 'insert',
      blocks: [{ type: 'paragraph', content: [] }],
      position: { after: 'p1' },
    };
    await expect(apply([insert], 'live:7')).rejects.toMatchObject({ code: 'BLOCK_CHANGED' });
    expect(posted()).toHaveLength(0);
  });

  it('falls back to the strict check for a version it never served (cache miss)', async () => {
    serve(15, LIVE_BLOCKS());
    await expect(apply([UPDATE_OP], 'live:7')).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
    });
    expect(posted()).toHaveLength(0);
  });

  it('replace_all always needs the current version', async () => {
    serve(7, LIVE_BLOCKS());
    await readOutline();
    serve(8, LIVE_BLOCKS());
    await expect(
      apply([{ op: 'replace_all', blocks: LIVE_BLOCKS() }], 'live:7')
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
  });

  it('a follow-up apply against the returned new_sha is checked per block', async () => {
    serve(7, LIVE_BLOCKS());
    await readOutline();
    const first = parse(await apply([UPDATE_OP], 'live:7'));
    expect(first.new_sha).toBe('live:8');
    // Someone typed in the heading after the agent's edit landed.
    const typed = LIVE_BLOCKS();
    typed[0].content = [{ type: 'text', text: 'Week one' }];
    serve(12, [typed[0], { ...UPDATE_OP.block, id: 'p1', props: { textColor: 'default' } }]);
    const second = parse(
      await apply([{ ...UPDATE_OP, block: { type: 'paragraph', content: [] } }], 'live:8')
    );
    expect(second.success).toBe(true);
  });

  it('applies without expected_sha (no pin)', async () => {
    serve(15, LIVE_BLOCKS());
    const result = parse(await apply([UPDATE_OP]));
    expect(result.committed_to).toBe('live');
    expect(posted()).toHaveLength(1);
  });

  it('still requires expected_sha outside live mode', async () => {
    mocks.pageFindById.mockResolvedValue(PLAIN_DRAFT);
    await expect(apply([UPDATE_OP])).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });
});

describe('preview mode with live editing', () => {
  it('a published page defaults to preview, cut from main, taking the live version', async () => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    const result = parse(
      await pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:7', ops: [UPDATE_OP] },
        CTX
      )
    );
    expect(result.committed_to).toBe('preview');
    expect(mocks.ensurePreviewBranch).toHaveBeenCalledTimes(1);
    // The CAS is on the sha actually loaded from main.
    expect(mocks.savePageContent.mock.calls[0][2]).toMatchObject({
      expectedSha: 'git-sha-1',
      branch: PREVIEW_BRANCH,
    });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('stacking onto an existing preview needs the preview sha, not a live version', async () => {
    mocks.pageFindById.mockResolvedValue(LIVE_PAGE);
    mocks.getPreviewStatus.mockResolvedValue({ exists: true });
    await expect(
      pageContentApplyTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, expected_sha: 'live:7', ops: [UPDATE_OP] },
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
      new_sha: 'live:9',
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
      new_sha: 'live:11',
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
  });
});
