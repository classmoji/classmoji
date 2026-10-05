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

  it("maps the server's block-changed (slide order included) to BLOCK_CHANGED", async () => {
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'block-changed', changedIds: ['__order__'] },
    }));
    await expect(apply([{ op: 'reorder', order: ['bbb', 'aaa'] }])).rejects.toMatchObject({
      code: 'BLOCK_CHANGED',
      data: { changed_ids: ['__order__'] },
    });
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
  const posts = () => calls.filter(call => call.method === 'POST');

  /** DECK() with the html block applied (what the live deck holds after the add). */
  function deckWithBlock(): DeckJson {
    return applyDeckOps(DECK(), [
      { op: 'block_add', slide: 'bbb', type: 'html', box: BOX, source: SOURCE, block_id: 'b1' },
    ]).deck;
  }

  it('live block_add: the block id is fixed before the ops travel, and reported', async () => {
    serve(4, DECK());
    await read();
    const result = parse(
      await apply([{ op: 'block_add', slide: 'bbb', type: 'html', box: BOX, source: SOURCE }])
    );
    const sent = posts()[0]?.body?.ops as Array<Record<string, unknown>>;
    expect(sent[0].block_id).toMatch(/^[0-9a-f]{8}$/);
    expect(result.applied).toEqual([
      { op: 'block_add', slide: 'bbb', block_id: sent[0].block_id, type: 'html' },
    ]);
    // Guarded by the pin, like an update of the slide holding the block.
    expect(posts()[0]?.body?.expect_since).toEqual({ epoch: 1, version: 4 });
    const audit = mocks.auditCreate.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(audit)).toContain(String(sent[0].block_id));
  });

  it('a block op the live service refuses (its slide changed) is BLOCK_CHANGED', async () => {
    serve(4, deckWithBlock());
    route('POST', 'ops', () => ({
      status: 409,
      body: { error: 'block-changed', changedIds: ['bbb'] },
    }));
    await expect(
      apply([{ op: 'block_delete', slide: 'bbb', block_id: 'b1' }])
    ).rejects.toMatchObject({ code: 'BLOCK_CHANGED', data: { changed_ids: ['bbb'] } });
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

  it('outline lists blocks (id, type, box); get returns the source decoded', async () => {
    serve(4, deckWithBlock());
    const outline = parse(await read());
    expect(outline.slides[0]).not.toHaveProperty('blocks');
    expect(outline.slides[1].blocks).toEqual([{ id: 'b1', type: 'html', box: BOX }]);

    const got = parse(
      await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, slide_ids: ['bbb'] }, CTX)
    );
    expect(got.slides[0].blocks).toEqual([{ id: 'b1', type: 'html', box: BOX, source: SOURCE }]);
    const whole = parse(await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX));
    expect(whole.slides[1].blocks[0].source).toBe(SOURCE);
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
      'one-file mini-game',
      'slide html ≤200 KB',
      'in-memory localStorage',
      'restarts when someone edits the slide',
      'multi-file games',
      'not live-editable',
      'static vector art',
      'scripts stripped',
    ]) {
      expect(schema, phrase).toContain(phrase);
    }
    expect(new TextEncoder().encode(apply?.description ?? '').length).toBeLessThan(1500);
    // The whole deck_apply entry stays well inside what clients load.
    expect(bytes(apply)).toBeLessThan(16_000);

    const upload = byName.get('file_upload_start');
    expect(upload?.description).toMatch(/multi-file game.*folder.*block_add type iframe/s);
    expect(upload?.description).toMatch(/html block/);
    expect(new TextEncoder().encode(upload?.description ?? '').length).toBeLessThan(1500);
    expect(JSON.stringify(upload?.inputSchema)).toContain('"folder"');
    expect(JSON.stringify(byName.get('file_import_url')?.inputSchema)).toContain('"folder"');
    expect(JSON.stringify(byName.get('deck_outline')?.description)).toMatch(/blocks/);
  });
});
