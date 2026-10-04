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

const { clearSnapshotCache } = await import('../../collab/liveCheck.ts');

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
  clearSnapshotCache();
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
      sha: 'live:4',
      sha_source: 'live',
      version: 4,
      slide_count: 2,
    });
    expect(outline.slides.map((s: { id: string }) => s.id)).toEqual(['aaa', 'bbb']);

    const got = parse(
      await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, slide_ids: ['bbb'] }, CTX)
    );
    expect(got).toMatchObject({ sha: 'live:4', slides: [{ id: 'bbb' }] });
    expect(mocks.loadDeck).not.toHaveBeenCalled();
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
          expected_sha: 'live:4',
          sha_source: 'live',
          ops: [UPDATE_OP],
        },
        CTX
      )
    );
    expect(result).toMatchObject({
      success: true,
      new_sha: 'live:5',
      sha_source: 'live',
      committed_to: 'live',
    });
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
          expected_sha: 'live:4',
          ops: [{ op: 'insert', slides: [{ html: '<p>New</p>' }], position: { at: 'end' } }],
        },
        CTX
      )
    );
    expect(result.applied[0]).toEqual({ op: 'insert', count: 1 });
    expect(result.note).toMatch(/deck_outline/);
  });

  it('refuses a stale version with CONTENT_CONFLICT and sends nothing', async () => {
    route('GET', 'snapshot', snapshotResponder(9));
    await expect(
      deckApplyTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha: 'live:4', ops: [UPDATE_OP] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
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
        { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha: 'live:4', ops: [UPDATE_OP] },
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
    mocks.slideFindById.mockResolvedValue(LIVE_SLIDE);
    const result = parse(
      await deckApplyTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          expected_sha: 'live:4',
          sha_source: 'live',
          ops: [UPDATE_OP],
        },
        CTX
      )
    );
    expect(result.committed_to).toBe('preview');
    expect(mocks.saveDeck.mock.calls[0][0]).toMatchObject({
      expectedSha: 'git-sha-1',
      shaSource: 'deck',
      branch: PREVIEW_BRANCH,
    });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });
});

describe('per-slide staleness check', () => {
  const serve = (version: number, deck: DeckJson) =>
    route('GET', 'snapshot', () => ({
      status: 200,
      body: { epoch: 1, version, live: true, content: deck },
    }));
  const read = () => deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX);
  const apply = (ops: unknown[], expected_sha = 'live:4') =>
    deckApplyTool.handler(
      { classroom: 'org/x', slide_id: SLIDE_ID, expected_sha, ops: ops as never },
      CTX
    );
  const posted = () => calls.filter(call => call.method === 'POST');

  it('applies when the targeted slide is unchanged though another slide was edited', async () => {
    serve(4, DECK());
    await read();
    serve(9, { ...DECK(), slides: [{ id: 'aaa', html: '<h1>Hi all</h1>' }, DECK().slides[1]] });
    const result = parse(await apply([UPDATE_OP]));
    expect(result).toMatchObject({ success: true, committed_to: 'live' });
    expect(posted()).toHaveLength(1);
  });

  it('refuses with BLOCK_CHANGED when the targeted slide was edited', async () => {
    serve(4, DECK());
    await read();
    serve(9, { ...DECK(), slides: [DECK().slides[0], { id: 'bbb', html: '<p>Edited</p>' }] });
    await expect(apply([UPDATE_OP])).rejects.toMatchObject({
      code: 'BLOCK_CHANGED',
      data: { changed_ids: ['bbb'] },
    });
    expect(posted()).toHaveLength(0);
  });

  it('a reorder is refused when the slide order changed since the read', async () => {
    serve(4, DECK());
    await read();
    serve(9, { ...DECK(), slides: [DECK().slides[1], DECK().slides[0]] });
    await expect(apply([{ op: 'reorder', order: ['bbb', 'aaa'] }])).rejects.toMatchObject({
      code: 'BLOCK_CHANGED',
      data: { changed_ids: ['__order__'] },
    });
  });

  it('falls back to the strict check on a cache miss', async () => {
    serve(9, DECK());
    await expect(apply([UPDATE_OP])).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
    expect(posted()).toHaveLength(0);
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
    expect(result).toMatchObject({ merged: true, committed_to: 'live', new_sha: 'live:6' });
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
