/**
 * Deck content tools in a classroom with live editing (collab_enabled): reads
 * come from the live deck, `mode: 'live'` applies ops through the collab
 * server with a version check (a slide a person holds refuses with 409
 * slide-locked), and a preview is accepted through the collab server's
 * merge-preview. The collab internal HTTP API is a stubbed `fetch`; an
 * unflagged classroom must never reach it.
 *
 * `@classmoji/services/slides` is mocked EXCEPT the pure deck engine
 * (deckHtml) and the conflict splitter (deckMerge), as in deck.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';
import type { DeckJson } from '../../../../../packages/services/src/slides/deckTypes.ts';

const mocks = vi.hoisted(() => ({
  slideFindById: vi.fn(),
  loadDeck: vi.fn(),
  saveDeck: vi.fn(),
  getDeckPreviewStatus: vi.fn(),
  ensureDeckPreviewBranch: vi.fn(),
  acceptDeckPreview: vi.fn(),
  resolveDeckPreviewConflicts: vi.fn(),
  discardDeckPreview: vi.fn(),
  resolveSharedThemeUrls: vi.fn(),
  compareBranches: vi.fn(),
  userFindById: vi.fn(),
  auditCreate: vi.fn(),
  findMembership: vi.fn(),
  writeHtmlBlockFile: vi.fn(),
  readHtmlBlockSources: vi.fn(),
  deleteHtmlBlockFile: vi.fn(),
  parseOwnFilesUrl: vi.fn(),
}));

/** Stands in for the service's typed refusal (deck tools map it by instance). */
const { FakeHtmlBlockFileError } = vi.hoisted(() => ({
  FakeHtmlBlockFileError: class extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.status = code === 'changed' ? 409 : 400;
    }
  },
}));

vi.mock('@classmoji/services/slides', async () => {
  const deckHtml = await vi.importActual<
    typeof import('../../../../../packages/services/src/slides/deckHtml.ts')
  >('../../../../../packages/services/src/slides/deckHtml.ts');
  const deckMerge = await vi.importActual<
    typeof import('../../../../../packages/services/src/slides/deckMerge.ts')
  >('../../../../../packages/services/src/slides/deckMerge.ts');
  return {
    ...deckHtml,
    splitDeckConflicts: deckMerge.splitDeckConflicts,
    previewBranchName: (contentPath: string) => `preview/${contentPath}`,
    PREVIEW_BRANCH_PREFIX: 'preview/',
    loadDeck: (...a: unknown[]) => mocks.loadDeck(...a),
    saveDeck: (...a: unknown[]) => mocks.saveDeck(...a),
    getDeckPreviewStatus: (...a: unknown[]) => mocks.getDeckPreviewStatus(...a),
    ensureDeckPreviewBranch: (...a: unknown[]) => mocks.ensureDeckPreviewBranch(...a),
    acceptDeckPreview: (...a: unknown[]) => mocks.acceptDeckPreview(...a),
    resolveDeckPreviewConflicts: (...a: unknown[]) => mocks.resolveDeckPreviewConflicts(...a),
    discardDeckPreview: (...a: unknown[]) => mocks.discardDeckPreview(...a),
    resolveSharedThemeUrls: (...a: unknown[]) => mocks.resolveSharedThemeUrls(...a),
    writeHtmlBlockFile: (...a: unknown[]) => mocks.writeHtmlBlockFile(...a),
    readHtmlBlockSources: (...a: unknown[]) => mocks.readHtmlBlockSources(...a),
    deleteHtmlBlockFile: (...a: unknown[]) => mocks.deleteHtmlBlockFile(...a),
    HtmlBlockFileError: FakeHtmlBlockFileError,
    slideService: {
      findById: (...a: unknown[]) => mocks.slideFindById(...a),
      STARTER_CUSTOM_CSS: 'STARTER_CSS',
    },
  };
});

vi.mock('@classmoji/services', () => ({
  ContentService: {
    compareBranches: (...a: unknown[]) => mocks.compareBranches(...a),
  },
  ClassmojiService: {
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    contentDelivery: {
      parseOwnFilesUrl: (...a: unknown[]) => mocks.parseOwnFilesUrl(...a),
    },
    user: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findMembership(...a),
    },
  },
}));

const { applyDeckOps } = await import('@classmoji/services/slides/ops');

const {
  deckOutlineTool,
  deckGetTool,
  deckApplyTool,
  deckPreviewAcceptTool,
  deckPreviewDiscardTool,
} = await import('../deck.ts');

const SLIDE_ID = '33333333-3333-4333-8333-333333333333';
const PREVIEW_BRANCH = 'preview/slides/intro-week';

const CTX = {
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-test-org-cs101',
  git_organization: { provider: 'GITHUB', login: 'test-org' },
};

/** A published deck in a classroom that edits live. */
const LIVE_SLIDE = {
  id: SLIDE_ID,
  classroom_id: 'class-1',
  title: 'Intro Week',
  slug: 'intro-week',
  content_path: 'slides/intro-week',
  is_draft: false,
  is_public: false,
  allow_team_edit: false,
  show_speaker_notes: false,
  created_by: 'teacher-1',
  updated_at: new Date('2026-08-01T00:00:00Z'),
  classroom: { ...CLASSROOM, collab_enabled: true },
};
const LIVE_DRAFT = { ...LIVE_SLIDE, is_draft: true };
const PLAIN_DRAFT = { ...LIVE_DRAFT, classroom: { ...CLASSROOM, collab_enabled: false } };

const DECK = (): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'aaa', html: '<h1>Welcome</h1>' },
    { id: 'bbb', html: '<p>Second slide</p>' },
  ],
});

// ─── Stubbed collab internal API ─────────────────────────────────────────────

interface CollabCall {
  method: string;
  path: string;
  /** The query string (`?viewer=…` on an agent's read). */
  search: string;
  body: Record<string, unknown> | null;
}

type Responder = (call: CollabCall) => { status: number; body: unknown } | 'network-error';

let calls: CollabCall[] = [];
let routes: Record<string, Responder> = {};

function route(method: string, action: string, responder: Responder) {
  routes[`${method} ${action}`] = responder;
}

const snapshotResponder =
  (version = 4): Responder =>
  () => ({ status: 200, body: { epoch: 1, version, live: true, content: DECK() } });

const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const parsed = new URL(String(url));
  const call: CollabCall = {
    method: init?.method ?? 'GET',
    path: parsed.pathname,
    search: parsed.search,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  };
  calls.push(call);
  const responder = routes[`${call.method} ${parsed.pathname.split('/').pop()}`];
  const result = responder ? responder(call) : { status: 404, body: { error: 'not-found' } };
  if (result === 'network-error') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(result.body), { status: result.status });
});

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  calls = [];
  routes = {};
  fakeFetch.mockClear();
  vi.stubGlobal('fetch', fakeFetch);
  mocks.slideFindById.mockResolvedValue(LIVE_DRAFT);
  mocks.findMembership.mockResolvedValue(null);
  mocks.getDeckPreviewStatus.mockResolvedValue({ exists: false });
  mocks.loadDeck.mockResolvedValue({ deck: DECK(), sha: 'git-sha-1', sha_source: 'deck' });
  mocks.saveDeck.mockResolvedValue({ sha: 'new-sha', commit: 'commit-sha', html: '<html>' });
  mocks.ensureDeckPreviewBranch.mockResolvedValue({ branch: PREVIEW_BRANCH, created: true });
  mocks.resolveSharedThemeUrls.mockResolvedValue(undefined);
  mocks.discardDeckPreview.mockResolvedValue({ existed: true });
  mocks.userFindById.mockResolvedValue({ id: 'teacher-1', name: 'Grace Hopper' });
  mocks.auditCreate.mockResolvedValue(undefined);
  let fileCount = 0;
  mocks.writeHtmlBlockFile.mockImplementation(async () => ({
    src: `blocks/f${String(++fileCount).padStart(7, '0')}.html`,
    rev: 'e'.repeat(40),
  }));
  mocks.deleteHtmlBlockFile.mockResolvedValue({ deleted: true });
  // A files URL of class-1 on the test content host → its repo path.
  mocks.parseOwnFilesUrl.mockImplementation((classroomId: string, url: string) => {
    const prefix = `https://content.test/c/${classroomId}/files/G/sig/`;
    if (classroomId !== 'class-1' || !url.startsWith(prefix)) return null;
    const [path, query = ''] = url.slice(prefix.length).split('?');
    return { repoPath: path, query: query ? `?${query}` : '' };
  });
  mocks.readHtmlBlockSources.mockResolvedValue([]);
  route('GET', 'snapshot', snapshotResponder());
  route('POST', 'ops', () => ({ status: 200, body: { version: 5 } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const UPDATE_OP = { op: 'update' as const, id: 'bbb', html: '<p>Second slide, edited</p>' };

describe('unflagged classroom', () => {
  it('reads and applies through git without calling the collab server', async () => {
    mocks.slideFindById.mockResolvedValue(PLAIN_DRAFT);
    const outline = parse(
      await deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );
    expect(outline).toMatchObject({ sha: 'git-sha-1', sha_source: 'deck' });
    const applied = parse(
      await deckApplyTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha: 'git-sha-1', ops: [UPDATE_OP] },
        CTX
      )
    );
    expect(applied).toMatchObject({ new_sha: 'new-sha', committed_to: 'main' });
    expect(mocks.saveDeck).toHaveBeenCalledTimes(1);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe('live reads', () => {
  it('outline and get read the live deck and report its version', async () => {
    const outline = parse(
      await deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );
    expect(outline).toMatchObject({
      sha: 'live:1.4',
      sha_source: 'live',
      version: 4,
      slide_count: 2,
    });
    expect(outline.slides.map((s: { id: string }) => s.id)).toEqual(['aaa', 'bbb']);

    const got = parse(
      await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, slide_ids: ['bbb'] }, CTX)
    );
    expect(got).toMatchObject({ sha: 'live:1.4', slides: [{ id: 'bbb' }] });
    expect(mocks.loadDeck).not.toHaveBeenCalled();
    // Agent reads: the live service remembers them for the agent's pin.
    expect(calls.map(call => call.search)).toEqual(['?viewer=teacher-1', '?viewer=teacher-1']);
  });

  it("a render reads with no viewer, so a picture never counts as the agent's read", async () => {
    const { readDeckForRender } = await import('../render.ts');
    const read = await readDeckForRender(LIVE_DRAFT as never, 'main');
    expect(read.version).toBe('live:1.4');
    expect(calls.map(call => call.search)).toEqual(['']);
  });

  it('maps an unexpected refusal on a read to a clear agent error', async () => {
    route('GET', 'snapshot', () => ({ status: 409, body: { error: 'unreadable-live-doc' } }));
    await expect(
      deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    ).rejects.toMatchObject({ code: 'LIVE_UNREADABLE' });
  });

  it('falls back to git and says so when the collab server is unreachable', async () => {
    route('GET', 'snapshot', () => 'network-error');
    const got = parse(await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX));
    expect(got).toMatchObject({ sha: 'git-sha-1', live_unavailable: true });
  });
});

describe('live apply', () => {
  it('a draft defaults to live: ops go to the collab server as the caller', async () => {
    const result = parse(
      await deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          expected_sha: 'live:1.4',
          sha_source: 'live',
          ops: [UPDATE_OP],
        },
        CTX
      )
    );
    expect(result).toMatchObject({
      success: true,
      new_sha: 'live:1.5',
      sha_source: 'live',
      committed_to: 'live',
    });
    expect(result).not.toHaveProperty('preview_url');
    expect(calls.find(call => call.method === 'POST')).toMatchObject({
      path: `/internal/deck/${SLIDE_ID}/ops`,
      body: { ops: [UPDATE_OP], actor: { userId: 'teacher-1', name: 'Grace Hopper' } },
    });
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('does not report locally minted ids for inserted slides', async () => {
    const result = parse(
      await deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          expected_sha: 'live:1.4',
          ops: [{ op: 'insert', slides: [{ html: '<p>New</p>' }], position: { at: 'end' } }],
        },
        CTX
      )
    );
    expect(result.applied[0]).toEqual({ op: 'insert', count: 1 });
    expect(result.note).toMatch(/deck_outline/);
  });

  it('a version the live service holds no read of is CONTENT_CONFLICT unknown-pin', async () => {
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'unknown-version', current: { epoch: 1, version: 9 } },
    }));
    await expect(
      deckApplyTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha: 'live:1.4', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      data: { reason: 'unknown-pin', current_sha: 'live:1.9' },
    });
  });

  it('a slide someone is editing names the slide and the holder, and suggests preview', async () => {
    route('POST', 'ops', () => ({
      status: 409,
      body: {
        error: 'slide-locked',
        slideId: 'bbb',
        holder: {
          userId: 'u-2',
          name: 'Alan Turing',
          color: '#f00',
          clientId: 3,
          since: 1,
          lastActive: 2,
        },
      },
    }));
    const error = await deckApplyTool
      .handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha: 'live:1.4', ops: [UPDATE_OP] },
        CTX
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: 'invalid_params',
      code: 'SLIDE_LOCKED',
      data: { slide_id: 'bbb', held_by: 'Alan Turing' },
    });
    expect((error as Error).message).toMatch(/Alan Turing is editing slide 'bbb'/);
    expect((error as Error).message).toMatch(/another slide/);
    expect((error as Error).message).toMatch(/mode: 'preview'/);
  });

  it('a published deck defaults to preview, cut from main, taking the live version', async () => {
    vi.stubEnv('SLIDES_URL', 'https://slides.example.test/');
    mocks.slideFindById.mockResolvedValue(LIVE_SLIDE);
    const result = parse(
      await deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          expected_sha: 'live:1.4',
          sha_source: 'live',
          ops: [UPDATE_OP],
        },
        CTX
      )
    );
    expect(result.committed_to).toBe('preview');
    expect(result.preview_url).toBe(`https://slides.example.test/${SLIDE_ID}?preview=1`);
    expect(mocks.saveDeck.mock.calls[0][0]).toMatchObject({
      expectedSha: 'git-sha-1',
      shaSource: 'deck',
      branch: PREVIEW_BRANCH,
    });
    // Nothing goes into the live document (only the preview notice is posted).
    expect(calls.some(call => call.path.endsWith('/ops'))).toBe(false);
  });
});

describe('per-slide staleness check (judged by the live service)', () => {
  const serve = (version: number, deck: DeckJson, epoch = 1) =>
    route('GET', 'snapshot', () => ({
      status: 200,
      body: { epoch, version, live: true, content: deck },
    }));
  const apply = (ops: unknown[], expected_sha = 'live:1.4') =>
    deckApplyTool.handler(
      { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha, ops: ops as never },
      CTX
    );
  const posted = () => calls.filter(call => call.method === 'POST');

  it('sends the pin as expect_since, with no hashes and no state of its own', async () => {
    // Read on another MCP machine (nothing here), the version moved on since.
    serve(9, DECK());
    const result = parse(await apply([UPDATE_OP]));
    expect(result).toMatchObject({ success: true, committed_to: 'live' });
    expect(posted()[0].body).toMatchObject({ expect_since: { epoch: 1, version: 4 } });
    expect(posted()[0].body).not.toHaveProperty('expect');
    // The apply's own pre-read is not an agent read.
    expect(calls.find(call => call.method === 'GET')?.search).toBe('');
  });

  it("maps the server's block-changed to BLOCK_CHANGED, naming order and theme in words", async () => {
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'block-changed', changedIds: ['__order__', '__meta__'] },
    }));
    const error = await apply([{ op: 'reorder', order: ['bbb', 'aaa'] }]).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'BLOCK_CHANGED',
      data: { changed_ids: [], order_changed: true, theme_changed: true },
    });
    expect((error as Error).message).toMatch(/the slide order; the theme/);
    expect((error as Error).message).not.toMatch(/__/);
  });

  it('refuses a pin from another epoch before sending anything', async () => {
    serve(4, DECK(), 2);
    await expect(apply([UPDATE_OP])).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      data: { reason: 'reloaded' },
    });
    expect(posted()).toHaveLength(0);
  });

  it('an attrs merge goes to the live deck as sent, guarded by the pin', async () => {
    const op = { op: 'update', id: 'bbb', attrs: { 'data-transition': 'fade', spellcheck: null } };
    expect(parse(await apply([op]))).toMatchObject({ success: true, committed_to: 'live' });
    expect(posted()[0]?.body).toMatchObject({
      ops: [op],
      expect_since: { epoch: 1, version: 4 },
    });
  });

  it('a pure insert may omit expected_sha (the server remembers its view); an update may not', async () => {
    const insert = { op: 'insert', slides: [{ html: '<p>New</p>' }], position: { at: 'end' } };
    const ok1 = parse(
      await deckApplyTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, ops: [insert] as never },
        CTX
      )
    );
    expect(ok1.committed_to).toBe('live');
    expect(posted()[0].body).toMatchObject({ remember: true });
    await expect(
      deckApplyTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, ops: [UPDATE_OP] }, CTX)
    ).rejects.toMatchObject({ code: 'EXPECTED_SHA_REQUIRED' });
  });

  it("a new stack's child ids come from the live deck", async () => {
    route('POST', 'ops', () => ({
      status: 200,
      body: { epoch: 1, version: 5, insertedIds: ['stk', 'k1', 'k2'] },
    }));
    const insert = {
      op: 'insert',
      slides: [{ children: [{ html: '<p>One</p>' }, { html: '<p>Two</p>' }] }],
      position: { at: 'end' },
    };
    const first = parse(await apply([insert]));
    expect(first.applied[0]).toMatchObject({ ids: ['stk'], children: { stk: ['k1', 'k2'] } });
    expect(first).not.toHaveProperty('note');
  });
});

describe('guarded deck ops and inserted ids', () => {
  const serve = (version: number, deck: DeckJson) =>
    route('GET', 'snapshot', () => ({
      status: 200,
      body: { epoch: 1, version, live: true, content: deck },
    }));
  const read = () => deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX);
  const apply = (ops: unknown[], expected_sha = 'live:1.4') =>
    deckApplyTool.handler(
      { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha, ops: ops as never },
      CTX
    );
  const lastPost = () => calls.filter(call => call.method === 'POST').at(-1);

  it("returns the live deck's ids for inserted slides", async () => {
    serve(4, DECK());
    await read();
    route('POST', 'ops', () => ({
      status: 200,
      body: { epoch: 1, version: 5, insertedIds: ['srv-slide'] },
    }));
    const insert = { op: 'insert', slides: [{ html: '<p>New</p>' }], position: { at: 'end' } };
    const first = parse(await apply([insert]));
    expect(first.applied[0]).toEqual({ op: 'insert', count: 1, ids: ['srv-slide'] });
    expect(first).not.toHaveProperty('note');
    expect(lastPost()?.body?.expect_since).toEqual({ epoch: 1, version: 4 });
  });

  it('a held slide refuses any change, and the message says notes and attributes too', async () => {
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'slide-locked', slideId: 'bbb', holder: { name: 'Alan Turing' } },
    }));
    const error = await apply([{ op: 'update', id: 'bbb', notes: '<p>n</p>' }]).catch(
      (e: unknown) => e
    );
    expect((error as Error).message).toMatch(/notes and attributes included/);
  });
});

describe('preview-changed notifications', () => {
  const notified = () =>
    calls.filter(call => call.method === 'POST' && call.path.endsWith('/preview-changed'));

  it('a preview apply and a discard tell open editors', async () => {
    route('POST', 'preview-changed', () => ({ status: 200, body: { broadcast: 0 } }));
    mocks.slideFindById.mockResolvedValue(LIVE_SLIDE);
    await deckApplyTool.handler(
      { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha: 'live:1.4', ops: [UPDATE_OP] },
      CTX
    );
    await deckPreviewDiscardTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX);
    expect(notified().map(call => call.path)).toEqual([
      `/internal/deck/${SLIDE_ID}/preview-changed`,
      `/internal/deck/${SLIDE_ID}/preview-changed`,
    ]);
  });
});

describe('live preview accept', () => {
  const PREVIEW_DECK = (): DeckJson => ({
    ...DECK(),
    slides: [DECK().slides[0], { id: 'bbb', html: '<p>Preview edit</p>' }],
  });

  beforeEach(() => {
    mocks.slideFindById.mockResolvedValue(LIVE_SLIDE);
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true });
    mocks.compareBranches.mockResolvedValue({ merge_base_sha: 'base-commit', ahead_by: 1 });
    mocks.loadDeck.mockImplementation(async (_slide, options: { ref?: string }) =>
      options?.ref === PREVIEW_BRANCH
        ? { deck: PREVIEW_DECK(), sha: 'preview-sha', sha_source: 'deck' }
        : { deck: DECK(), sha: 'base-sha', sha_source: 'deck' }
    );
  });

  it('merges through collab /merge-preview, then deletes the preview branch', async () => {
    route('POST', 'merge-preview', () => ({ status: 200, body: { applied: true, version: 6 } }));
    const result = parse(
      await deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );
    expect(result).toMatchObject({ merged: true, committed_to: 'live', version: 6 });
    expect(calls.find(call => call.method === 'POST')).toMatchObject({
      path: `/internal/deck/${SLIDE_ID}/merge-preview`,
      body: {
        base: DECK(),
        theirs: PREVIEW_DECK(),
        actor: { userId: 'teacher-1', name: 'Grace Hopper' },
      },
    });
    expect(mocks.discardDeckPreview).toHaveBeenCalledTimes(1);
    expect(mocks.acceptDeckPreview).not.toHaveBeenCalled();
  });

  it('keeps the preview when it gained commits during the accept', async () => {
    route('POST', 'merge-preview', () => ({ status: 200, body: { applied: true, version: 6 } }));
    mocks.compareBranches
      .mockResolvedValueOnce({ merge_base_sha: 'base-commit', head_sha: 'head-1', ahead_by: 1 })
      .mockResolvedValueOnce({ merge_base_sha: 'base-commit', head_sha: 'head-2', ahead_by: 2 });
    const result = parse(
      await deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );
    expect(result).toMatchObject({ merged: true, preview_kept: true });
    expect(mocks.discardDeckPreview).not.toHaveBeenCalled();
  });

  it('a conflict returns units + order_conflict and keeps the preview', async () => {
    route('POST', 'merge-preview', () => ({
      status: 409,
      body: {
        error: 'conflicts',
        conflicts: [
          { id: 'bbb', index: '2', reason: 'content', ours: { id: 'bbb' }, theirs: { id: 'bbb' } },
          { id: '__order__', index: '', reason: 'order', base: ['a'], ours: ['b'], theirs: ['c'] },
        ],
      },
    }));
    const result = parse(
      await deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );
    expect(result).toMatchObject({
      conflict: true,
      units: [{ id: 'bbb' }],
      order_conflict: { base: ['a'], ours: ['b'], theirs: ['c'] },
      theirs_sha: 'preview-sha',
    });
    expect(result.message).toMatch(/2 conflict/);
    expect(mocks.discardDeckPreview).not.toHaveBeenCalled();
  });

  it('a slide someone is editing stops the accept and keeps the preview', async () => {
    route('POST', 'merge-preview', () => ({
      status: 409,
      body: { error: 'slide-locked', slideId: 'bbb', holder: { name: 'Alan Turing' } },
    }));
    await expect(
      deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    ).rejects.toMatchObject({ code: 'SLIDE_LOCKED' });
    expect(mocks.discardDeckPreview).not.toHaveBeenCalled();
  });
});

describe('tool descriptions', () => {
  it('stay under the 1,500 UTF-8 bytes a client will keep and explain the modes', () => {
    for (const tool of [
      deckOutlineTool,
      deckGetTool,
      deckApplyTool,
      deckPreviewAcceptTool,
      deckPreviewDiscardTool,
    ]) {
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
    expect(deckApplyTool.description).toMatch(/mode: 'live'/);
    expect(deckApplyTool.description).toMatch(/big edits/);
  });
});

// ─── svg / html / iframe blocks ─────────────────────────────────────────────

describe('block ops', () => {
  const BOX = { left: 10, top: 20, width: 400, height: 300 };
  const SOURCE =
    '<!doctype html><canvas id="c"></canvas><script>let s = "a < b && \'c\'";</script>';
  const REV = 'a'.repeat(40);
  const NEW_REV = 'e'.repeat(40);
  const serve = (version: number, deck: DeckJson) =>
    route('GET', 'snapshot', () => ({
      status: 200,
      body: { epoch: 1, version, live: true, content: deck },
    }));
  const read = () => deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX);
  const apply = (ops: unknown[], expected_sha = 'live:1.4', extra: Record<string, unknown> = {}) =>
    deckApplyTool.handler(
      { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha, ops: ops as never, ...extra },
      CTX
    );
  const posts = () => calls.filter(call => call.method === 'POST');

  /** DECK() with an html file block (what the live deck holds after the add). */
  function deckWithBlock(): DeckJson {
    return applyDeckOps(DECK(), [
      {
        op: 'block_add',
        slide: 'bbb',
        type: 'html',
        box: BOX,
        src: 'blocks/0a0b0c0d.html',
        rev: REV,
        block_id: 'b1',
      },
    ]).deck;
  }

  it('live block_add with source: the code is written to a new file and the op travels as src + rev', async () => {
    serve(4, DECK());
    await read();
    const result = parse(
      await apply([{ op: 'block_add', slide: 'bbb', type: 'html', box: BOX, source: SOURCE }])
    );
    const sent = posts()[0]?.body?.ops as Array<Record<string, unknown>>;
    expect(sent[0].block_id).toMatch(/^[0-9a-f]{8}$/);
    expect(sent[0]).not.toHaveProperty('source');
    expect(sent[0]).toMatchObject({ src: 'blocks/f0000001.html', rev: NEW_REV });
    expect(mocks.writeHtmlBlockFile).toHaveBeenCalledWith({
      slideId: SLIDE_ID,
      actorUserId: 'teacher-1',
      html: SOURCE,
      mode: 'live',
      blockId: sent[0].block_id,
      surface: 'mcp',
    });
    expect(result.applied).toEqual([
      {
        op: 'block_add',
        slide: 'bbb',
        block_id: sent[0].block_id,
        type: 'html',
        src: 'blocks/f0000001.html',
        rev: NEW_REV,
      },
    ]);
    // Guarded by the pin, like an update of the slide holding the block.
    expect(posts()[0]?.body?.expect_since).toEqual({ epoch: 1, version: 4 });
    const audit = mocks.auditCreate.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(audit)).toContain(String(sent[0].block_id));
  });

  it('live block_update with source writes a new file and keeps the one the block named (other decks may name it)', async () => {
    serve(4, deckWithBlock());
    await read();
    const result = parse(
      await apply([{ op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v2</p>' }])
    );
    const write = mocks.writeHtmlBlockFile.mock.calls[0][0];
    expect(write).toMatchObject({ html: '<p>v2</p>', mode: 'live', blockId: 'b1' });
    // Never over the file the deck names now.
    expect(write).not.toHaveProperty('src');
    expect(write).not.toHaveProperty('expectedRev');
    const sent = posts()[0]?.body?.ops as Array<Record<string, unknown>>;
    expect(sent[0]).toEqual({
      op: 'block_update',
      slide: 'bbb',
      block_id: 'b1',
      src: 'blocks/f0000001.html',
      rev: NEW_REV,
    });
    expect(result.applied[0]).toMatchObject({ src: 'blocks/f0000001.html', rev: NEW_REV });
    // No block of this deck names it any more, but another deck may, and the
    // published deck does until the next checkpoint.
    expect(mocks.deleteHtmlBlockFile).not.toHaveBeenCalled();
  });

  it('two sources for one block in a call: the deck names the last file, only the one written between goes', async () => {
    serve(4, deckWithBlock());
    await read();
    mocks.deleteHtmlBlockFile.mockImplementation(async () => {
      // The deck write has landed by the time the file goes.
      expect(posts()).toHaveLength(1);
      return { deleted: true };
    });
    await apply([
      { op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v2</p>' },
      { op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v3</p>' },
    ]);
    const sent = posts()[0]?.body?.ops as Array<Record<string, unknown>>;
    expect(sent.map(op => op.src)).toEqual(['blocks/f0000001.html', 'blocks/f0000002.html']);
    expect(mocks.deleteHtmlBlockFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteHtmlBlockFile).toHaveBeenCalledWith({
      slideId: SLIDE_ID,
      actorUserId: 'teacher-1',
      src: 'blocks/f0000001.html',
      surface: 'mcp',
    });
  });

  it('a file written earlier in the call is kept while another block of the deck names it', async () => {
    serve(4, deckWithBlock());
    await read();
    await apply([
      { op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v2</p>' },
      // A second block given the file the first one is about to leave.
      {
        op: 'block_add',
        slide: 'aaa',
        type: 'html',
        box: BOX,
        src: 'blocks/f0000001.html',
        rev: NEW_REV,
        block_id: 'b2',
      },
      { op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v3</p>' },
    ]);
    const sent = posts()[0]?.body?.ops as Array<Record<string, unknown>>;
    expect(sent.at(-1)).toMatchObject({ src: 'blocks/f0000002.html' });
    expect(mocks.deleteHtmlBlockFile).not.toHaveBeenCalled();
  });

  it('a refused live write leaves the deck and the old file as they were', async () => {
    serve(4, deckWithBlock());
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'block-changed', changedIds: ['bbb'] },
    }));
    await read();
    await expect(
      apply([{ op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v2</p>' }])
    ).rejects.toMatchObject({ code: 'BLOCK_CHANGED' });
    // The new file is written (and left unused); nothing is deleted.
    expect(mocks.writeHtmlBlockFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteHtmlBlockFile).not.toHaveBeenCalled();
  });

  it('a file that cannot be written is refused and nothing travels', async () => {
    serve(4, deckWithBlock());
    await read();
    mocks.writeHtmlBlockFile.mockRejectedValueOnce(
      new FakeHtmlBlockFileError('too-large', "This block's code is too large")
    );
    await expect(
      apply([{ op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v2</p>' }])
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(posts()).toHaveLength(0);
    expect(mocks.deleteHtmlBlockFile).not.toHaveBeenCalled();
  });

  it('a preview keeps the old file: the published deck still names it', async () => {
    mocks.slideFindById.mockResolvedValue(LIVE_SLIDE);
    mocks.loadDeck.mockResolvedValue({
      deck: deckWithBlock(),
      sha: 'git-sha-1',
      sha_source: 'deck',
    });
    serve(4, deckWithBlock());
    await read();
    const result = parse(
      await apply([{ op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v2</p>' }])
    );
    expect(result.committed_to).toBe('preview');
    expect(mocks.writeHtmlBlockFile.mock.calls[0][0]).toMatchObject({ mode: 'preview' });
    expect(mocks.deleteHtmlBlockFile).not.toHaveBeenCalled();
  });

  it('frame URLs made for display travel as the stored deck-relative references', async () => {
    serve(4, DECK());
    await read();
    const files = 'https://content.test/c/class-1/files/G/sig/';
    const other = 'https://content.test/c/class-2/files/G/sig/';
    await apply([
      {
        op: 'update',
        id: 'bbb',
        html:
          `<iframe data-src="/${SLIDE_ID}/frame/slides/intro-week/games/x/index.html?cm-rev=1" ` +
          'data-cm-orig-data-src="games/x/index.html"></iframe>' +
          `<iframe src="${files}games/y/a.html?level=2"></iframe>` +
          `<iframe src="${other}games/z/a.html"></iframe>`,
        notes: `<iframe src="${files}slides/intro-week/n.html"></iframe>`,
        attrs: { 'data-background-iframe': `${files}games/bg/index.html`, spellcheck: null },
      },
      {
        op: 'insert',
        position: { at: 'end' },
        slides: [{ html: `<iframe src="${files}slides/intro-week/games/w/index.html"></iframe>` }],
      },
    ]);
    const [update, insert] = posts()[0]?.body?.ops as Array<Record<string, unknown>>;
    const html = String(update.html);
    expect(html).toContain('data-src="games/x/index.html"');
    expect(html).toContain('src="../../games/y/a.html?level=2"');
    expect(html).not.toContain('/frame/');
    expect(html).not.toContain('data-cm-orig');
    // Another classroom's files URL is not ours to undo.
    expect(html).toContain(`src="${other}games/z/a.html"`);
    expect(update.notes).toBe('<iframe src="n.html"></iframe>');
    expect(update.attrs).toEqual({
      'data-background-iframe': '../../games/bg/index.html',
      spellcheck: null,
    });
    expect((insert.slides as Array<{ html: string }>)[0].html).toBe(
      '<iframe src="games/w/index.html"></iframe>'
    );
  });

  it('every op is judged before a file is written', async () => {
    serve(4, DECK());
    await read();
    await expect(
      apply([
        { op: 'block_add', slide: 'bbb', type: 'html', box: BOX, source: SOURCE },
        { op: 'block_update', slide: 'bbb', block_id: 'zz', box: { top: 1 } },
      ])
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringMatching(/No block 'zz'/),
    });
    await expect(
      apply([
        {
          op: 'block_add',
          slide: 'bbb',
          type: 'html',
          box: BOX,
          source: SOURCE,
          src: 'blocks/0a0b0c0d.html',
        },
      ])
    ).rejects.toMatchObject({ kind: 'invalid_params', message: expect.stringMatching(/not both/) });
    expect(mocks.writeHtmlBlockFile).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
  });

  it('html src: a repo file of the deck becomes deck-relative; one outside is kept as written', async () => {
    serve(4, DECK());
    await read();
    await apply([
      {
        op: 'block_add',
        slide: 'bbb',
        type: 'html',
        box: BOX,
        src: 'slides/intro-week/games/snake/index.html',
      },
      {
        op: 'block_add',
        slide: 'aaa',
        type: 'html',
        box: BOX,
        src: '../../games/sketchkit/draw.html?deck=x',
      },
    ]);
    const sent = posts()[0]?.body?.ops as Array<Record<string, unknown>>;
    expect(sent.map(op => op.src)).toEqual([
      'games/snake/index.html',
      '../../games/sketchkit/draw.html?deck=x',
    ]);
    expect(mocks.writeHtmlBlockFile).not.toHaveBeenCalled();
  });

  it('block_delete delete_file: deletes the file when no other block names it, after the write', async () => {
    serve(4, deckWithBlock());
    await read();
    const result = parse(
      await apply([{ op: 'block_delete', slide: 'bbb', block_id: 'b1', delete_file: true }])
    );
    expect(mocks.deleteHtmlBlockFile).toHaveBeenCalledWith({
      slideId: SLIDE_ID,
      actorUserId: 'teacher-1',
      src: 'blocks/0a0b0c0d.html',
      blockId: 'b1',
      surface: 'mcp',
    });
    expect(result.applied[0]).toMatchObject({ file: 'blocks/0a0b0c0d.html', file_deleted: true });
  });

  it('block_delete delete_file keeps a file another block names; without it nothing is deleted', async () => {
    const shared = applyDeckOps(deckWithBlock(), [
      {
        op: 'block_add',
        slide: 'aaa',
        type: 'html',
        box: BOX,
        src: './blocks/0a0b0c0d.html',
        block_id: 'b2',
      },
    ]).deck;
    serve(4, shared);
    await read();
    const kept = parse(
      await apply([{ op: 'block_delete', slide: 'bbb', block_id: 'b1', delete_file: true }])
    );
    expect(kept.applied[0]).toMatchObject({ file_deleted: false });
    await apply([{ op: 'block_delete', slide: 'aaa', block_id: 'b2' }], 'live:1.4');
    expect(mocks.deleteHtmlBlockFile).not.toHaveBeenCalled();
  });

  it('a refused live write deletes nothing', async () => {
    serve(4, deckWithBlock());
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'block-changed', changedIds: ['bbb'] },
    }));
    await expect(
      apply([{ op: 'block_delete', slide: 'bbb', block_id: 'b1', delete_file: true }])
    ).rejects.toMatchObject({ code: 'BLOCK_CHANGED', data: { changed_ids: ['bbb'] } });
    expect(mocks.deleteHtmlBlockFile).not.toHaveBeenCalled();
  });

  it('block ops need a pin, like updates', async () => {
    await expect(
      deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          ops: [{ op: 'block_delete', slide: 'bbb', block_id: 'b1' }] as never,
        },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
  });

  it('an iframe src (an upload ref or a deck path) is resolved to its /content URL before it travels', async () => {
    serve(4, DECK());
    await read();
    await apply([
      {
        op: 'block_add',
        slide: 'bbb',
        type: 'iframe',
        box: BOX,
        src: 'slides/intro-week/games/minions/index.html',
      },
    ]);
    const sent = posts()[0]?.body?.ops as Array<Record<string, unknown>>;
    expect(sent[0].src).toBe(
      '/content/test-org/content-test-org-cs101/slides/intro-week/games/minions/index.html'
    );
  });

  it('refuses a bad src or unknown block plainly and sends nothing', async () => {
    serve(4, DECK());
    await read();
    await expect(
      apply([
        { op: 'block_add', slide: 'bbb', type: 'iframe', box: BOX, src: 'javascript:alert(1)' },
      ])
    ).rejects.toMatchObject({ kind: 'invalid_params', message: expect.stringMatching(/https/) });
    await expect(
      apply([{ op: 'block_update', slide: 'bbb', block_id: 'zz', box: { top: 1 } }])
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringMatching(/No block 'zz'/),
    });
    expect(posts()).toHaveLength(0);
  });

  it('outline lists blocks (id, type, box, src, rev); get adds the code of blocks/ files', async () => {
    serve(4, deckWithBlock());
    mocks.readHtmlBlockSources.mockResolvedValue([
      { src: 'blocks/0a0b0c0d.html', html: SOURCE, rev: REV, stale: false },
    ]);
    const outline = parse(await read());
    expect(outline.slides[0]).not.toHaveProperty('blocks');
    expect(outline.slides[1].blocks).toEqual([
      { id: 'b1', type: 'html', box: BOX, src: 'blocks/0a0b0c0d.html', rev: REV },
    ]);
    expect(mocks.readHtmlBlockSources).not.toHaveBeenCalled();

    const got = parse(
      await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, slide_ids: ['bbb'] }, CTX)
    );
    expect(got.slides[0].blocks).toEqual([
      { id: 'b1', type: 'html', box: BOX, src: 'blocks/0a0b0c0d.html', rev: REV, source: SOURCE },
    ]);
    // A teaching-team read, as the deck read itself.
    expect(mocks.readHtmlBlockSources).toHaveBeenCalledWith({
      slideId: SLIDE_ID,
      actorUserId: 'teacher-1',
      refs: [{ src: 'blocks/0a0b0c0d.html', rev: REV }],
      access: 'view',
    });
  });

  it('get bounds the code it returns, and a failed read omits it', async () => {
    const many = applyDeckOps(
      DECK(),
      Array.from({ length: 14 }, (_, i) => ({
        op: 'block_add' as const,
        slide: 'bbb',
        type: 'html' as const,
        box: BOX,
        src: `blocks/${String(i).padStart(8, '0')}.html`,
        block_id: `b${i}`,
      }))
    ).deck;
    serve(4, many);
    mocks.readHtmlBlockSources.mockImplementation(
      async ({ refs }: { refs: Array<{ src: string }> }) =>
        refs.map(({ src }, i) => ({
          src,
          html: i === 1 ? 'y'.repeat(399_000) : 'x'.repeat(600),
          rev: REV,
          stale: false,
        }))
    );
    const got = parse(await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX));
    const blocks = got.slides[1].blocks as Array<Record<string, unknown>>;
    expect(mocks.readHtmlBlockSources.mock.calls[0][0].refs).toHaveLength(12);
    expect(blocks[0].source).toHaveLength(600);
    expect(blocks[1].source).toHaveLength(399_000);
    expect(blocks[2]).not.toHaveProperty('source');
    // Past the byte budget, then past the file cap.
    expect(blocks.filter(b => b.source_omitted)).toHaveLength(blocks.length - 2);

    mocks.readHtmlBlockSources.mockRejectedValue(new Error('GitHub is down'));
    const failed = parse(
      await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );
    expect(failed.slides[1].blocks[0]).toMatchObject({ source_omitted: true });
  });

  it('a block made before block ids is listed under a derived id that block_update reaches', async () => {
    const old =
      '<div class="sl-block" data-block-type="iframe" style="left: 10px; top: 10px; width: 200px; height: 100px;">' +
      '<div class="sl-block-content"><iframe data-src="https://example.com/a"></iframe></div></div>';
    serve(4, { ...DECK(), slides: [DECK().slides[0], { id: 'bbb', html: old }] });
    const outline = parse(await read());
    const [block] = outline.slides[1].blocks;
    expect(block.id).toMatch(/^[0-9a-f]{8}$/);
    const result = parse(
      await apply([{ op: 'block_update', slide: 'bbb', block_id: block.id, box: { left: 50 } }])
    );
    expect(result.applied).toEqual([{ op: 'block_update', slide: 'bbb', block_id: block.id }]);
    expect(posts()).toHaveLength(1);
  });

  it('the decoded blocks never leak into the remembered read (a pinned apply still passes)', async () => {
    serve(4, deckWithBlock());
    await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX);
    const result = parse(
      await apply([{ op: 'block_update', slide: 'bbb', block_id: 'b1', box: { left: 0 } }])
    );
    expect(result.success).toBe(true);
    expect(result.applied).toEqual([{ op: 'block_update', slide: 'bbb', block_id: 'b1' }]);
  });

  it('git mode: the saved deck holds the block, src resolved', async () => {
    mocks.slideFindById.mockResolvedValue(PLAIN_DRAFT);
    const result = parse(
      await deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          expected_sha: 'git-sha-1',
          ops: [
            { op: 'block_add', slide: 'aaa', type: 'iframe', box: BOX, src: 'games/x/index.html' },
          ] as never,
        },
        CTX
      )
    );
    expect(result.applied[0]).toMatchObject({ op: 'block_add', slide: 'aaa', type: 'iframe' });
    const saved = mocks.saveDeck.mock.calls[0][0].deck as DeckJson;
    expect(saved.slides[0].html).toContain(
      'data-src="/content/test-org/content-test-org-cs101/slides/intro-week/games/x/index.html"'
    );
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('git mode: the deck save lands before a file the call left is deleted; the prior file stays', async () => {
    mocks.slideFindById.mockResolvedValue(PLAIN_DRAFT);
    mocks.loadDeck.mockResolvedValue({
      deck: deckWithBlock(),
      sha: 'git-sha-1',
      sha_source: 'deck',
    });
    mocks.deleteHtmlBlockFile.mockImplementation(async () => {
      expect(mocks.saveDeck).toHaveBeenCalledTimes(1);
      return { deleted: true };
    });
    await deckApplyTool.handler(
      {
        classroom: 'org/x',
        slide_id: SLIDE_ID,
        expected_sha: 'git-sha-1',
        ops: [
          { op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v2</p>' },
          { op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v3</p>' },
        ] as never,
      },
      CTX
    );
    const saved = mocks.saveDeck.mock.calls[0][0].deck as DeckJson;
    expect(saved.slides[1].html).toContain('data-cm-src="blocks/f0000002.html"');
    expect(mocks.deleteHtmlBlockFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteHtmlBlockFile).toHaveBeenCalledWith(
      expect.objectContaining({ src: 'blocks/f0000001.html' })
    );
  });

  it('git mode: a stale sha writes no file; preview always writes a new file and cannot delete files', async () => {
    mocks.slideFindById.mockResolvedValue(PLAIN_DRAFT);
    await expect(
      deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          expected_sha: 'stale',
          ops: [{ op: 'block_add', slide: 'aaa', type: 'html', box: BOX, source: SOURCE }] as never,
        },
        CTX
      )
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
    expect(mocks.writeHtmlBlockFile).not.toHaveBeenCalled();

    mocks.loadDeck.mockResolvedValue({
      deck: deckWithBlock(),
      sha: 'git-sha-1',
      sha_source: 'deck',
    });
    const result = parse(
      await deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          expected_sha: 'git-sha-1',
          mode: 'preview',
          ops: [{ op: 'block_update', slide: 'bbb', block_id: 'b1', source: '<p>v2</p>' }] as never,
        },
        CTX
      )
    );
    expect(result.committed_to).toBe('preview');
    expect(mocks.writeHtmlBlockFile.mock.calls[0][0]).toMatchObject({ mode: 'preview' });
    expect(mocks.writeHtmlBlockFile.mock.calls[0][0]).not.toHaveProperty('src');
    const saved = mocks.saveDeck.mock.calls[0][0].deck as DeckJson;
    expect(saved.slides[1].html).toContain(`data-cm-rev="${NEW_REV}"`);
    expect(saved.slides[1].html).not.toContain('srcdoc');

    await expect(
      deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          expected_sha: 'git-sha-1',
          mode: 'preview',
          ops: [{ op: 'block_delete', slide: 'bbb', block_id: 'b1', delete_file: true }] as never,
        },
        CTX
      )
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringMatching(/delete_file/),
    });
    expect(mocks.deleteHtmlBlockFile).not.toHaveBeenCalled();
  });
});

describe('the block guide reaches tools/list', () => {
  it('deck_apply carries it in the op fields; file_upload_start in one line; all under budget', async () => {
    const { buildMcpServer, registerToolDefinition } = await import('../../mcp/registry.ts');
    const { fileUploadStartTool, fileImportUrlTool } = await import('../media.ts');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    for (const tool of [
      deckApplyTool,
      deckOutlineTool,
      deckGetTool,
      fileUploadStartTool,
      fileImportUrlTool,
    ]) {
      try {
        registerToolDefinition(tool as never);
      } catch {
        // already registered by an earlier run in this worker
      }
    }
    const server = buildMcpServer({
      userId: 'teacher-1',
      clientId: 'c',
      scopes: new Set(['read', 'write']),
    } as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'blocks-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

    const apply = byName.get('deck_apply');
    const schema = JSON.stringify(apply?.inputSchema);
    for (const phrase of [
      'block_add',
      'interactive HTML file',
      'blocks/<id>.html',
      '≤1 MB',
      'multi-file games',
      'relative to the deck folder',
      'delete_file',
      'other decks are not checked',
      'static vector art',
      'scripts stripped',
    ]) {
      expect(schema, phrase).toContain(phrase);
    }
    expect(new TextEncoder().encode(apply?.description ?? '').length).toBeLessThan(1500);
    // The whole deck_apply entry stays well inside what clients load.
    expect(bytes(apply)).toBeLessThan(16_000);

    const upload = byName.get('file_upload_start');
    expect(upload?.description).toMatch(/multi-file game.*folder.*block_add type html with src/s);
    expect(upload?.description).toMatch(/html block/);
    expect(new TextEncoder().encode(upload?.description ?? '').length).toBeLessThan(1500);
    expect(JSON.stringify(upload?.inputSchema)).toContain('"folder"');
    expect(JSON.stringify(byName.get('file_import_url')?.inputSchema)).toContain('"folder"');
    expect(JSON.stringify(byName.get('deck_outline')?.description)).toMatch(/blocks/);
  });
});
