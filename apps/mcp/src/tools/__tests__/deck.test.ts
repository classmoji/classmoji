/**
 * Unit tests for the deck content tools (content-tools plan Phase 5, §9 P5,
 * mirroring pageContent.test.ts):
 * deck_outline / deck_get / deck_apply + deck_preview_accept / deck_preview_discard.
 *
 * Focus: S1 scoping, the assertSlideEditable sub-gate on writes, the
 * optimistic lock (stale sha OR wrong sha_source → CONTENT_CONFLICT, never a
 * clobber), preview routing (draft→direct vs published→preview defaults,
 * explicit overrides, stacking), op semantics (incl. normalizeSlideHtml
 * rejection of <section> injection), accept clean/conflict/discard, and
 * enriched audit rows.
 *
 * `@classmoji/services/slides` is mocked EXCEPT the pure deck engine
 * (deckHtml.ts: normalizeSlideHtml, mintSlideId, DeckParseError,
 * SlideHtmlError, BUILTIN_THEMES) — the tools' op behavior is only meaningful
 * against the real HTML normalization.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  auditCreate: vi.fn(),
  findMembership: vi.fn(),
}));

vi.mock('@classmoji/services/slides', async () => {
  // Real pure engine — normalization/validation semantics must be genuine.
  const deckHtml = await vi.importActual<
    typeof import('../../../../../packages/services/src/slides/deckHtml.ts')
  >('../../../../../packages/services/src/slides/deckHtml.ts');
  return {
    ...deckHtml,
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
  ClassmojiService: {
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findMembership(...a),
    },
  },
}));

const { DeckParseError } = await vi.importActual<
  typeof import('../../../../../packages/services/src/slides/deckHtml.ts')
>('../../../../../packages/services/src/slides/deckHtml.ts');

const {
  deckOutlineTool,
  deckGetTool,
  deckApplyTool,
  deckPreviewAcceptTool,
  deckPreviewDiscardTool,
} = await import('../deck.ts');

const SLIDE_ID = '33333333-3333-4333-8333-333333333333';
const PREVIEW_BRANCH = 'preview/slides/intro-week';

function makeCtx(role: 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT', userId = 'user-1') {
  return {
    viewer: { userId, clientId: 'c', scopes: new Set(['read', 'write']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { settings: {} },
    },
  } as unknown as ToolContext;
}

const CTX = makeCtx('TEACHER', 'teacher-1');
const ASSISTANT_CTX = makeCtx('ASSISTANT', 'ta-1');

/** Published deck (is_draft false) — applies default to the preview branch. */
const SLIDE = {
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
  classroom: {
    id: 'class-1',
    content_namespace: 'cs101',
    git_organization: { provider: 'GITHUB', login: 'test-org' },
  },
};

const DRAFT_SLIDE = { ...SLIDE, is_draft: true };

const LONG_TEXT =
  'This slide heading is deliberately far longer than the eighty character preview budget ' +
  'so the outline must truncate it with an ellipsis marker';

/** Deck: 2 leaf slides + 1 vertical stack (2 children), starter customCss. */
const DECK = (): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  customCss: 'STARTER_CSS',
  slides: [
    { id: 'aaa', html: `<h1>${LONG_TEXT}</h1>`, notes: '<p>speaker notes</p>' },
    { id: 'bbb', html: '<p>Second slide</p>', hidden: true },
    {
      id: 'stack',
      children: [
        { id: 'c1', html: '<p>child one</p>' },
        { id: 'c2', html: '<p>child two</p>' },
      ],
    },
  ],
});

const loadedDeck = (
  deck: DeckJson = DECK(),
  sha = 'sha-1',
  sha_source: 'deck' | 'legacy_html' = 'deck'
) => ({
  deck,
  sha,
  sha_source,
});

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.slideFindById.mockResolvedValue(SLIDE);
  mocks.findMembership.mockResolvedValue(null);
  mocks.getDeckPreviewStatus.mockResolvedValue({ exists: false });
  mocks.loadDeck.mockResolvedValue(loadedDeck());
  mocks.saveDeck.mockResolvedValue({ sha: 'new-sha', commit: 'commit-sha', html: '<html>' });
  mocks.ensureDeckPreviewBranch.mockResolvedValue({ branch: PREVIEW_BRANCH, created: true });
  mocks.resolveSharedThemeUrls.mockResolvedValue(undefined);
  mocks.auditCreate.mockResolvedValue(undefined);
});

// ─── S1: cross-classroom decks are invisible to every tool ──────────────────

describe('S1 classroom scoping', () => {
  const APPLY = {
    classroom: 'org/x',
    slide_id: SLIDE_ID,
    expected_sha: 'sha-1',
    ops: [{ op: 'delete' as const, id: 'bbb' }],
  };
  const attempts: Array<[string, () => Promise<unknown>]> = [
    [
      'deck_outline',
      () => deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX),
    ],
    ['deck_get', () => deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)],
    ['deck_apply', () => deckApplyTool.handler(APPLY, CTX)],
    [
      'deck_preview_accept',
      () => deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX),
    ],
    [
      'deck_preview_discard',
      () => deckPreviewDiscardTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX),
    ],
  ];

  it.each(attempts)(
    '%s rejects a foreign deck with scopedNotFound and never touches GitHub',
    async (_name, run) => {
      mocks.slideFindById.mockResolvedValue({ ...SLIDE, classroom_id: 'OTHER-classroom' });

      await expect(run()).rejects.toMatchObject({ kind: 'not_found' });

      expect(mocks.slideFindById).toHaveBeenCalledWith(SLIDE_ID, { includeClassroom: true });
      for (const fn of [
        mocks.loadDeck,
        mocks.saveDeck,
        mocks.acceptDeckPreview,
        mocks.discardDeckPreview,
        mocks.ensureDeckPreviewBranch,
        mocks.auditCreate,
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  );
});

// ─── Sub-gate on writes ──────────────────────────────────────────────────────

describe('assertSlideEditable sub-gate on deck writes', () => {
  const APPLY = {
    classroom: 'org/x',
    slide_id: SLIDE_ID,
    expected_sha: 'sha-1',
    ops: [{ op: 'update' as const, id: 'bbb', hidden: false }],
  };

  it("deck_apply: ASSISTANT on someone else's locked deck is forbidden before any load", async () => {
    await expect(deckApplyTool.handler(APPLY, ASSISTANT_CTX)).rejects.toMatchObject({
      kind: 'forbidden',
      code: 'INSUFFICIENT_ROLE',
    });
    expect(mocks.loadDeck).not.toHaveBeenCalled();
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('deck_apply: ASSISTANT creator passes', async () => {
    mocks.slideFindById.mockResolvedValue({ ...SLIDE, created_by: 'ta-1' });
    const payload = parse(await deckApplyTool.handler(APPLY, ASSISTANT_CTX));
    expect(payload.success).toBe(true);
  });

  it('preview accept/discard enforce the same sub-gate', async () => {
    await expect(
      deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, ASSISTANT_CTX)
    ).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(
      deckPreviewDiscardTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, ASSISTANT_CTX)
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.acceptDeckPreview).not.toHaveBeenCalled();
    expect(mocks.discardDeckPreview).not.toHaveBeenCalled();
  });
});

// ─── deck_outline ────────────────────────────────────────────────────────────

describe('deck_outline', () => {
  it('returns theme info, truncated previews, dotted indexes, hidden/has_notes flags', async () => {
    const payload = parse(
      await deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      slide_id: SLIDE_ID,
      format: 'deck',
      sha: 'sha-1',
      sha_source: 'deck',
      at: 'main',
      theme: 'white',
      code_theme: 'github',
      slide_count: 5, // 3 top-level + 2 stack children
      preview: { exists: false },
    });

    const [first, second, stack] = payload.slides;
    expect(first).toMatchObject({ id: 'aaa', index: '1', hidden: false, has_notes: true });
    expect(first.preview.length).toBe(80);
    expect(first.preview.endsWith('…')).toBe(true);
    expect(first.preview.startsWith('This slide heading is deliberately')).toBe(true);

    expect(second).toMatchObject({
      id: 'bbb',
      index: '2',
      preview: 'Second slide',
      hidden: true,
      has_notes: false,
    });

    expect(stack).toMatchObject({ id: 'stack', index: '3' });
    expect(stack.children).toHaveLength(2);
    expect(stack.children[0]).toMatchObject({ id: 'c1', index: '3.1', preview: 'child one' });
    expect(stack.children[1]).toMatchObject({ id: 'c2', index: '3.2' });

    // Sha-bearing read — must bypass the cache.
    expect(mocks.loadDeck.mock.calls[0][1]).toMatchObject({ skipCache: true });
  });

  it('reports a pending preview with commits_ahead and age', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    mocks.getDeckPreviewStatus.mockResolvedValue({
      exists: true,
      commits_ahead: 2,
      oldest_commit_at: twoHoursAgo,
    });

    const payload = parse(
      await deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload.preview).toMatchObject({ exists: true, commits_ahead: 2, age: '2h' });
  });

  it("at: 'preview' reads FROM the preview branch", async () => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });

    await deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, at: 'preview' }, CTX);

    expect(mocks.loadDeck.mock.calls[0][1]).toMatchObject({
      skipCache: true,
      ref: PREVIEW_BRANCH,
    });
  });

  it("at: 'preview' without a pending preview is invalid_params", async () => {
    await expect(
      deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, at: 'preview' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.loadDeck).not.toHaveBeenCalled();
  });

  it('unparseable deck → format legacy_html with web-editor guidance', async () => {
    mocks.loadDeck.mockRejectedValue(new DeckParseError('Document contains no slide sections'));

    const payload = parse(
      await deckOutlineTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      format: 'legacy_html',
      sha: null,
      slide_count: 0,
      slides: [],
      parse_error: 'Document contains no slide sections',
    });
    expect(payload.message).toMatch(/web slides editor/);
  });
});

// ─── deck_get ────────────────────────────────────────────────────────────────

describe('deck_get', () => {
  it('returns the whole deck with config/custom_css and full slide objects', async () => {
    const payload = parse(
      await deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      format: 'deck',
      sha: 'sha-1',
      sha_source: 'deck',
      slide_count: 5,
      custom_css: 'STARTER_CSS',
    });
    expect(payload.slides).toHaveLength(3);
    expect(payload.slides[0]).toMatchObject({
      id: 'aaa',
      html: `<h1>${LONG_TEXT}</h1>`,
      notes: '<p>speaker notes</p>',
    });
  });

  it('fetches a subset by slide_ids, reaching stack children', async () => {
    const payload = parse(
      await deckGetTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, slide_ids: ['c2', 'aaa'] },
        CTX
      )
    );

    expect(payload.slides).toHaveLength(2);
    expect(payload.slides[0].id).toBe('c2');
    expect(payload.slides[1].id).toBe('aaa');
    // Deck-level extras only ride on whole-deck reads.
    expect(payload.custom_css).toBeUndefined();
  });

  it('names an unknown slide id (invalid_params)', async () => {
    await expect(
      deckGetTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, slide_ids: ['ghost'] }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining("'ghost'"),
    });
  });
});

// ─── deck_apply ──────────────────────────────────────────────────────────────

const APPLY_ARGS = {
  classroom: 'org/x',
  slide_id: SLIDE_ID,
  expected_sha: 'sha-1',
  ops: [{ op: 'update' as const, id: 'bbb', html: '<p>Updated second</p>' }],
};

describe('deck_apply routing + locking', () => {
  it('published deck defaults to the preview branch (ensured, then committed to)', async () => {
    const payload = parse(await deckApplyTool.handler(APPLY_ARGS, CTX));

    expect(payload).toMatchObject({
      success: true,
      new_sha: 'new-sha',
      sha_source: 'deck',
      committed_to: 'preview',
      slide_count: 5,
      applied: [{ op: 'update', id: 'bbb' }],
    });

    // No existing preview → loaded from main (no ref), branch ensured, save on branch.
    expect(mocks.loadDeck.mock.calls[0][1]).not.toHaveProperty('ref');
    expect(mocks.ensureDeckPreviewBranch).toHaveBeenCalledTimes(1);
    const saveArgs = mocks.saveDeck.mock.calls[0][0] as Record<string, unknown>;
    expect(saveArgs).toMatchObject({
      expectedSha: 'sha-1',
      shaSource: 'deck',
      branch: PREVIEW_BRANCH,
    });

    // The updated slide landed (id preserved, html normalized-through).
    const savedDeck = saveArgs.deck as DeckJson;
    expect(savedDeck.slides[1]).toMatchObject({ id: 'bbb', html: '<p>Updated second</p>' });
  });

  it('draft deck defaults to a direct commit on main', async () => {
    mocks.slideFindById.mockResolvedValue(DRAFT_SLIDE);

    const payload = parse(await deckApplyTool.handler(APPLY_ARGS, CTX));

    expect(payload.committed_to).toBe('main');
    expect(mocks.getDeckPreviewStatus).not.toHaveBeenCalled();
    expect(mocks.ensureDeckPreviewBranch).not.toHaveBeenCalled();
    const saveArgs = mocks.saveDeck.mock.calls[0][0] as Record<string, unknown>;
    expect(saveArgs.branch).toBeUndefined();
  });

  it("explicit commit overrides both defaults ('direct' on published, 'preview' on draft)", async () => {
    let payload = parse(await deckApplyTool.handler({ ...APPLY_ARGS, commit: 'direct' }, CTX));
    expect(payload.committed_to).toBe('main');
    expect(mocks.ensureDeckPreviewBranch).not.toHaveBeenCalled();

    mocks.slideFindById.mockResolvedValue(DRAFT_SLIDE);
    payload = parse(await deckApplyTool.handler({ ...APPLY_ARGS, commit: 'preview' }, CTX));
    expect(payload.committed_to).toBe('preview');
    expect(mocks.ensureDeckPreviewBranch).toHaveBeenCalledTimes(1);
  });

  it('stacks onto an EXISTING preview: loads from the branch it will commit to', async () => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });

    await deckApplyTool.handler(APPLY_ARGS, CTX);

    expect(mocks.loadDeck.mock.calls[0][1]).toMatchObject({
      skipCache: true,
      ref: PREVIEW_BRANCH,
    });
    const saveArgs = mocks.saveDeck.mock.calls[0][0] as Record<string, unknown>;
    expect(saveArgs.branch).toBe(PREVIEW_BRANCH);
  });

  it('stale expected_sha → CONTENT_CONFLICT, and the write never happens', async () => {
    await expect(
      deckApplyTool.handler({ ...APPLY_ARGS, expected_sha: 'stale-sha' }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'CONTENT_CONFLICT',
      message: expect.stringContaining('deck_get'),
    });
    expect(mocks.saveDeck).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('sha_source mismatch (deck.json materialized since a legacy read) → CONTENT_CONFLICT', async () => {
    // Caller read legacy html, but the load now finds deck.json.
    await expect(
      deckApplyTool.handler({ ...APPLY_ARGS, sha_source: 'legacy_html' }, CTX)
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('legacy deck: matching legacy sha+source proceeds and saveDeck materializes deck.json', async () => {
    mocks.loadDeck.mockResolvedValue(loadedDeck(DECK(), 'html-sha', 'legacy_html'));

    const payload = parse(
      await deckApplyTool.handler(
        { ...APPLY_ARGS, expected_sha: 'html-sha', sha_source: 'legacy_html' },
        CTX
      )
    );

    expect(payload).toMatchObject({ success: true, sha_source: 'deck' });
    const saveArgs = mocks.saveDeck.mock.calls[0][0] as Record<string, unknown>;
    expect(saveArgs).toMatchObject({ expectedSha: 'html-sha', shaSource: 'legacy_html' });
  });

  it('a 409 from saveDeck (race after our read) also maps to CONTENT_CONFLICT', async () => {
    mocks.saveDeck.mockRejectedValue(
      Object.assign(new Error('Deck changed since it was read'), { status: 409 })
    );

    await expect(deckApplyTool.handler(APPLY_ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'CONTENT_CONFLICT',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a 409 after THIS apply created the branch deletes the fresh (empty) preview', async () => {
    // No preview existed; ensure creates one; then the save conflicts.
    mocks.ensureDeckPreviewBranch.mockResolvedValue({ branch: PREVIEW_BRANCH, created: true });
    mocks.saveDeck.mockRejectedValue(
      Object.assign(new Error('Deck changed since it was read'), { status: 409 })
    );

    await expect(deckApplyTool.handler(APPLY_ARGS, CTX)).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
    });
    // The stranded empty branch is cleaned up (best-effort)…
    expect(mocks.discardDeckPreview).toHaveBeenCalledTimes(1);
  });

  it('a 409 while STACKING keeps the pre-existing preview branch', async () => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });
    mocks.ensureDeckPreviewBranch.mockResolvedValue({ branch: PREVIEW_BRANCH, created: false });
    mocks.saveDeck.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));

    await expect(deckApplyTool.handler(APPLY_ARGS, CTX)).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      // Stacking conflicts must name the preview re-read (F12).
      message: expect.stringContaining("at: 'preview'"),
    });
    expect(mocks.discardDeckPreview).not.toHaveBeenCalled();
  });

  it('conflict messages name the compared ref: preview when stacking, plain re-read otherwise', async () => {
    // Non-stacking (no preview existed): plain deck_get guidance.
    await expect(
      deckApplyTool.handler({ ...APPLY_ARGS, expected_sha: 'stale-sha' }, CTX)
    ).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      message: expect.not.stringContaining("at: 'preview'"),
    });

    // Stacking (preview existed, loaded from it): preview re-read guidance.
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });
    await expect(
      deckApplyTool.handler({ ...APPLY_ARGS, expected_sha: 'stale-sha' }, CTX)
    ).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      message: expect.stringContaining("at: 'preview'"),
    });
  });

  it('unparseable deck refuses granular ops with web-editor guidance', async () => {
    mocks.loadDeck.mockRejectedValue(new DeckParseError('no sections'));

    await expect(deckApplyTool.handler(APPLY_ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringMatching(/web slides editor/),
    });
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });
});

describe('deck_apply op semantics', () => {
  const run = (ops: unknown[]) =>
    deckApplyTool.handler({ ...APPLY_ARGS, ops: ops as typeof APPLY_ARGS.ops }, CTX);
  const savedDeck = () => (mocks.saveDeck.mock.calls[0][0] as { deck: DeckJson }).deck;

  it('rejects html containing <section> tags via normalizeSlideHtml (no write)', async () => {
    await expect(
      run([{ op: 'update', id: 'bbb', html: '<p>hi</p></section><section>injected' }])
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('<section>'),
    });
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('rejects <section> injection through NOTES too', async () => {
    await expect(
      run([{ op: 'update', id: 'bbb', notes: '</section><section>' }])
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('normalizes pre>code content (escape-to-text, hljs stripped) like the editor', async () => {
    await run([
      {
        op: 'update',
        id: 'bbb',
        html: '<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> x = 1;</code></pre>',
      },
    ]);
    const slide = savedDeck().slides[1];
    expect(slide.html).toBe('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  it('update: unknown id is named; container html is refused; notes/hidden/attrs clear correctly', async () => {
    await expect(run([{ op: 'update', id: 'ghost', hidden: true }])).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining("'ghost'"),
    });

    await expect(run([{ op: 'update', id: 'stack', html: '<p>nope</p>' }])).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('stack container'),
    });

    await expect(run([{ op: 'update', id: 'bbb' }])).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('at least one'),
    });

    mocks.saveDeck.mockClear();
    await run([
      { op: 'update', id: 'aaa', notes: null },
      { op: 'update', id: 'bbb', hidden: false, attrs: { 'data-transition': 'fade' } },
    ]);
    const deck = savedDeck();
    expect(deck.slides[0].notes).toBeUndefined();
    expect(deck.slides[1].hidden).toBeUndefined();
    expect(deck.slides[1].attrs).toEqual({ 'data-transition': 'fade' });
  });

  it('insert mints fresh non-colliding ids and normalizes html', async () => {
    const payload = parse(
      await run([
        {
          op: 'insert',
          slides: [{ html: '<h2>New</h2>' }, { html: '<p>Another</p>', hidden: true }],
          position: { after: 'aaa' },
        },
      ])
    );

    const deck = savedDeck();
    expect(deck.slides).toHaveLength(5);
    expect(deck.slides[1].html).toBe('<h2>New</h2>');
    expect(deck.slides[2].hidden).toBe(true);
    const existing = new Set(['aaa', 'bbb', 'stack', 'c1', 'c2']);
    for (const inserted of [deck.slides[1], deck.slides[2]]) {
      expect(existing.has(inserted.id)).toBe(false);
      expect(inserted.id).toMatch(/^[0-9a-f]{8}$/);
    }
    expect(payload.applied[0]).toMatchObject({ op: 'insert', count: 2 });
  });

  it('insert can target a stack child (becomes a sibling within the stack)', async () => {
    await run([{ op: 'insert', slides: [{ html: '<p>mid</p>' }], position: { after: 'c1' } }]);
    const stack = savedDeck().slides[2];
    expect(stack.children).toHaveLength(3);
    expect(stack.children?.[1].html).toBe('<p>mid</p>');
  });

  it('insert creates a vertical stack from children (minted ids reported, no container html)', async () => {
    const payload = parse(
      await run([
        {
          op: 'insert',
          slides: [
            {
              children: [
                { html: '<h2>Child A</h2>', notes: 'child notes' },
                { html: '<h2>Child B</h2>', hidden: true },
              ],
              attrs: { 'data-background-color': '#123' },
            },
          ],
          position: { at: 'end' },
        },
      ])
    );

    const deck = savedDeck();
    const container = deck.slides[deck.slides.length - 1];
    expect(container.html).toBeUndefined();
    expect(container.attrs).toEqual({ 'data-background-color': '#123' });
    expect(container.children).toHaveLength(2);
    expect(container.children?.[0].html).toBe('<h2>Child A</h2>');
    expect(container.children?.[0].notes).toBe('child notes');
    expect(container.children?.[1].hidden).toBe(true);
    for (const s of [container, ...(container.children ?? [])]) {
      expect(s.id).toMatch(/^[0-9a-f]{8}$/);
    }
    const entry = payload.applied[0] as { ids: string[]; children: Record<string, string[]> };
    expect(entry.children[entry.ids[0]]).toHaveLength(2);
  });

  it('insert stack rejects html-on-container, empty spec, and nested-stack positions', async () => {
    // html + children together → schema refine rejects.
    await expect(
      run([
        {
          op: 'insert',
          slides: [{ html: '<p>no</p>', children: [{ html: '<p>c</p>' }] }],
          position: { at: 'end' },
        },
      ])
    ).rejects.toMatchObject({ kind: 'invalid_params' });

    // Neither html nor children → schema refine rejects.
    await expect(
      run([{ op: 'insert', slides: [{ hidden: true }], position: { at: 'end' } }])
    ).rejects.toMatchObject({ kind: 'invalid_params' });

    // Inserting a stack at a position inside another stack → targeted DeckOpError.
    await expect(
      run([
        {
          op: 'insert',
          slides: [{ children: [{ html: '<p>c</p>' }] }],
          position: { after: 'c1' },
        },
      ])
    ).rejects.toMatchObject({ kind: 'invalid_params' });

    // Children cannot nest (strict child schema has no children field).
    await expect(
      run([
        {
          op: 'insert',
          slides: [{ children: [{ html: '<p>c</p>', children: [{ html: '<p>g</p>' }] }] }],
          position: { at: 'end' },
        },
      ])
    ).rejects.toMatchObject({ kind: 'invalid_params' });
  });

  it('move repositions slides ({ after } and { at })', async () => {
    await run([{ op: 'move', id: 'bbb', position: { at: 'start' } }]);
    expect(savedDeck().slides.map(s => s.id)).toEqual(['bbb', 'aaa', 'stack']);
  });

  it('delete removes a slide but refuses to empty the deck', async () => {
    const payload = parse(await run([{ op: 'delete', id: 'bbb' }]));
    expect(savedDeck().slides.map(s => s.id)).toEqual(['aaa', 'stack']);
    expect(payload.applied).toEqual([{ op: 'delete', id: 'bbb' }]);

    mocks.saveDeck.mockClear();
    await expect(
      run([
        { op: 'delete', id: 'aaa' },
        { op: 'delete', id: 'bbb' },
        { op: 'delete', id: 'stack' },
      ])
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('at least one slide'),
    });
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('reorder applies a permutation and rejects anything else', async () => {
    await run([{ op: 'reorder', order: ['stack', 'aaa', 'bbb'] }]);
    expect(savedDeck().slides.map(s => s.id)).toEqual(['stack', 'aaa', 'bbb']);

    for (const order of [
      ['aaa', 'bbb'], // missing one
      ['aaa', 'bbb', 'ghost'], // unknown id
      ['aaa', 'aaa', 'bbb'], // duplicate
      ['aaa', 'bbb', 'c1'], // child id is not top-level
    ]) {
      await expect(run([{ op: 'reorder', order }])).rejects.toMatchObject({
        kind: 'invalid_params',
        message: expect.stringContaining('permutation'),
      });
    }
  });

  it('set_theme validates, clears paired dark themes, and drops starter customCss on change', async () => {
    await expect(run([{ op: 'set_theme', theme: 'not-a-theme' }])).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining("'not-a-theme'"),
    });

    mocks.loadDeck.mockResolvedValue(
      loadedDeck({ ...DECK(), themeDark: 'night', codeThemeDark: 'monokai' })
    );
    await run([{ op: 'set_theme', theme: 'dracula' }]);
    const deck = savedDeck();
    expect(deck.theme).toBe('dracula');
    expect(deck.themeDark).toBeUndefined(); // cleared on theme change
    expect(deck.codeThemeDark).toBe('monokai'); // codeTheme untouched
    expect(deck.customCss).toBeUndefined(); // starter css dropped

    mocks.saveDeck.mockClear();
    mocks.loadDeck.mockResolvedValue(loadedDeck({ ...DECK(), customCss: 'custom stuff' }));
    await run([{ op: 'set_theme', theme: 'shared:corp', code_theme: 'monokai' }]);
    const deck2 = savedDeck();
    expect(deck2.theme).toBe('shared:corp');
    expect(deck2.codeTheme).toBe('monokai');
    expect(deck2.customCss).toBe('custom stuff'); // non-starter css preserved
  });

  it('set_theme rejects traversal in shared:/custom: names (no /, no ..)', async () => {
    for (const theme of [
      'shared:../../x',
      'shared:a/b',
      'custom:../evil.css',
      'custom:themes/evil.css',
      'shared:',
    ]) {
      await expect(run([{ op: 'set_theme', theme }])).rejects.toMatchObject({
        kind: 'invalid_params',
        message: expect.stringContaining('Invalid theme name'),
      });
    }
    expect(mocks.saveDeck).not.toHaveBeenCalled();

    // Legitimate names still pass (custom names include '.css').
    await run([{ op: 'set_theme', theme: 'custom:my-theme.css' }]);
    expect(savedDeck().theme).toBe('custom:my-theme.css');
  });

  it('move rejects placing a stack container at a nested position', async () => {
    await expect(
      run([{ op: 'move', id: 'stack', position: { after: 'c1' } }])
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('nested stacks are not supported'),
    });
    expect(mocks.saveDeck).not.toHaveBeenCalled();

    // A LEAF can still move into a stack, and a container can move at top level.
    await run([{ op: 'move', id: 'bbb', position: { after: 'c1' } }]);
    expect(savedDeck().slides.map(s => s.id)).toEqual(['aaa', 'stack']);

    mocks.saveDeck.mockClear();
    await run([{ op: 'move', id: 'stack', position: { at: 'start' } }]);
    expect(savedDeck().slides.map(s => s.id)).toEqual(['stack', 'aaa', 'bbb']);
  });

  it('sequential visibility: a reorder after insert must cover the inserted slide', async () => {
    await expect(
      run([
        { op: 'insert', slides: [{ html: '<p>temp</p>' }], position: { at: 'end' } },
        { op: 'reorder', order: ['bbb', 'aaa', 'stack'] },
      ])
    ).rejects.toMatchObject({ kind: 'invalid_params' });
  });

  it('writes ONE enriched audit row per apply (prior_slide_count on deletes)', async () => {
    await run([
      { op: 'update', id: 'aaa', html: '<h1>t</h1>' },
      { op: 'delete', id: 'bbb' },
    ]);

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      resource_type: string;
      resource_id: string;
      action: string;
      data: Record<string, unknown>;
    };
    expect(audit).toMatchObject({
      resource_type: 'SLIDES',
      resource_id: SLIDE_ID,
      action: 'UPDATE',
    });
    expect(audit.data).toMatchObject({
      tool: 'deck_apply',
      ops: [
        { op: 'update', id: 'aaa' },
        { op: 'delete', id: 'bbb' },
      ],
      expected_sha: 'sha-1',
      new_sha: 'new-sha',
      commit_sha: 'commit-sha',
      committed_to: 'preview',
      prior_slide_count: 5,
    });
  });

  it('omits prior_slide_count when no destructive op is present', async () => {
    await deckApplyTool.handler(APPLY_ARGS, CTX);
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect('prior_slide_count' in audit.data).toBe(false);
  });
});

// ─── deck_preview_accept ─────────────────────────────────────────────────────

describe('deck_preview_accept', () => {
  it('refuses when no preview exists (nothing to accept)', async () => {
    await expect(
      deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.acceptDeckPreview).not.toHaveBeenCalled();
  });

  it('clean merge: success payload (incl. html_regenerated) + audit + theme resolver wired', async () => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.acceptDeckPreview.mockResolvedValue({
      merged: true,
      sha: 'merge-sha',
      html_regenerated: true,
    });

    const payload = parse(
      await deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload).toEqual({
      success: true,
      merged: true,
      new_sha: 'merge-sha',
      html_regenerated: true,
    });

    // The accept passes a resolver that resolves shared-theme URLs (§3b:
    // regenerate-on-accept needs them for the artifact).
    const opts = mocks.acceptDeckPreview.mock.calls[0][1] as {
      resolveThemeUrls: (deck: DeckJson) => Promise<unknown>;
    };
    expect(opts.resolveThemeUrls).toBeTypeOf('function');
    await opts.resolveThemeUrls(DECK());
    expect(mocks.resolveSharedThemeUrls).toHaveBeenCalledTimes(1);

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: Record<string, unknown>;
    };
    expect(audit.action).toBe('UPDATE');
    expect(audit.data).toMatchObject({
      tool: 'deck_preview_accept',
      outcome: 'merged',
      new_sha: 'merge-sha',
      html_regenerated: true,
    });
  });

  it('preview_kept (concurrent stacking apply during accept) surfaces in payload + audit', async () => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.acceptDeckPreview.mockResolvedValue({
      merged: true,
      sha: 'merge-sha',
      html_regenerated: true,
      preview_kept: true,
      reason: 'Preview branch gained 1 new commit(s) during accept — retained with the newer edits',
    });

    const payload = parse(
      await deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      success: true,
      merged: true,
      preview_kept: true,
      message: expect.stringContaining('preview branch was retained'),
    });

    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({ preview_kept: true, reason: expect.any(String) });
  });

  it('conflict: structured per-unit report as a NON-error payload, with guidance + audit', async () => {
    const units = [
      { id: 'aaa', index: '1', ours: { id: 'aaa' }, theirs: { id: 'aaa' }, base: { id: 'aaa' } },
    ];
    const orderConflict = { base: ['aaa'], ours: ['aaa'], theirs: ['aaa'] };
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.acceptDeckPreview.mockResolvedValue({
      merged: false,
      conflict: true,
      units,
      order_conflict: orderConflict,
      auto_merged: 3,
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });

    const result = await deckPreviewAcceptTool.handler(
      { classroom: 'org/x', slide_id: SLIDE_ID },
      CTX
    );
    expect(result.isError).toBeUndefined(); // ok() payload, not a tool error
    const payload = parse(result);

    expect(payload).toMatchObject({
      conflict: true,
      units,
      order_conflict: orderConflict,
      auto_merged: 3,
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });
    expect(payload.message).toMatch(/deck_get/);
    expect(payload.message).toMatch(/deck_preview_discard/);
    // The report teaches the resolutions path and names the counts.
    expect(payload.message).toMatch(/resolutions/);
    expect(payload.message).toContain('3 change(s) auto-merge cleanly');
    expect(payload.message).toContain('2 conflict(s)');

    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({
      tool: 'deck_preview_accept',
      outcome: 'conflict',
      conflict_unit_ids: ['aaa'],
      order_conflict: true,
      auto_merged: 3,
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });
  });

  it('a semantic auto-merge surfaces semantic + auto_merged in payload and audit', async () => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.acceptDeckPreview.mockResolvedValue({
      merged: true,
      semantic: true,
      auto_merged: 7,
      sha: 'merge-sha',
      html_regenerated: true,
    });

    const payload = parse(
      await deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload).toEqual({
      success: true,
      merged: true,
      semantic: true,
      auto_merged: 7,
      new_sha: 'merge-sha',
      html_regenerated: true,
    });
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({ outcome: 'merged', semantic: true, auto_merged: 7 });
  });

  it('a 409 during the semantic merge maps to CONTENT_CONFLICT', async () => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });
    mocks.acceptDeckPreview.mockRejectedValue(
      Object.assign(new Error('Deck changed since it was read'), { status: 409 })
    );

    await expect(
      deckPreviewAcceptTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'CONTENT_CONFLICT',
      message: expect.stringContaining('deck_preview_accept'),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

// ─── deck_preview_accept — resolutions ───────────────────────────────────────

describe('deck_preview_accept with resolutions', () => {
  const RESOLUTIONS = [
    { id: 'aaa', choose: 'ours' as const },
    { id: '__order__', choose: 'theirs' as const },
  ];

  beforeEach(() => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.resolveDeckPreviewConflicts.mockResolvedValue({
      merged: true,
      semantic: true,
      html_regenerated: true,
      auto_merged: 4,
      resolved: RESOLUTIONS,
      sha: 'resolved-sha',
    });
  });

  it('routes to resolveDeckPreviewConflicts (with the theme resolver) and audits the choices', async () => {
    const payload = parse(
      await deckPreviewAcceptTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, resolutions: RESOLUTIONS },
        CTX
      )
    );

    expect(payload).toEqual({
      success: true,
      merged: true,
      semantic: true,
      resolved: RESOLUTIONS,
      auto_merged: 4,
      new_sha: 'resolved-sha',
      html_regenerated: true,
    });

    expect(mocks.acceptDeckPreview).not.toHaveBeenCalled();
    expect(mocks.resolveDeckPreviewConflicts).toHaveBeenCalledTimes(1);
    const opts = mocks.resolveDeckPreviewConflicts.mock.calls[0][1] as {
      resolutions: unknown;
      resolveThemeUrls: (deck: DeckJson) => Promise<unknown>;
    };
    expect(opts.resolutions).toEqual(RESOLUTIONS);
    expect(opts.resolveThemeUrls).toBeTypeOf('function');
    await opts.resolveThemeUrls(DECK());
    expect(mocks.resolveSharedThemeUrls).toHaveBeenCalledTimes(1);

    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({
      tool: 'deck_preview_accept',
      outcome: 'merged',
      semantic: true,
      resolutions: RESOLUTIONS,
      auto_merged: 4,
      new_sha: 'resolved-sha',
    });
  });

  it('maps PreviewResolutionError to invalid_params carrying its code AND ids — no audit', async () => {
    mocks.resolveDeckPreviewConflicts.mockRejectedValue(
      Object.assign(new Error('Every conflict needs a choice — missing: bbb'), {
        name: 'PreviewResolutionError',
        code: 'UNRESOLVED_CONFLICTS',
        ids: ['bbb'],
      })
    );

    await expect(
      deckPreviewAcceptTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, resolutions: RESOLUTIONS },
        CTX
      )
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'UNRESOLVED_CONFLICTS',
      data: { ids: ['bbb'] },
      message: expect.stringContaining('bbb'),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('passes expected_ours_sha/expected_theirs_sha through to the resolve service (F3)', async () => {
    await deckPreviewAcceptTool.handler(
      {
        classroom: 'org/x',
        slide_id: SLIDE_ID,
        resolutions: RESOLUTIONS,
        expected_ours_sha: 'report-ours-sha',
        expected_theirs_sha: 'report-theirs-sha',
      },
      CTX
    );

    expect(mocks.resolveDeckPreviewConflicts.mock.calls[0][1]).toMatchObject({
      resolutions: RESOLUTIONS,
      expectedOursSha: 'report-ours-sha',
      expectedTheirsSha: 'report-theirs-sha',
    });
  });

  it('maps a stale sha pin (CONTENT_CONFLICT PreviewResolutionError) to the CONTENT_CONFLICT code', async () => {
    mocks.resolveDeckPreviewConflicts.mockRejectedValue(
      Object.assign(new Error('The live deck changed since the conflict report — re-run accept'), {
        name: 'PreviewResolutionError',
        code: 'CONTENT_CONFLICT',
        ids: [],
      })
    );

    await expect(
      deckPreviewAcceptTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          resolutions: RESOLUTIONS,
          expected_ours_sha: 'stale',
        },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params', code: 'CONTENT_CONFLICT' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('still requires a pending preview', async () => {
    mocks.getDeckPreviewStatus.mockResolvedValue({ exists: false });

    await expect(
      deckPreviewAcceptTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, resolutions: RESOLUTIONS },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.resolveDeckPreviewConflicts).not.toHaveBeenCalled();
  });
});

// ─── deck_preview_discard ────────────────────────────────────────────────────

describe('deck_preview_discard', () => {
  it('discards the preview and audits the deletion', async () => {
    mocks.discardDeckPreview.mockResolvedValue({ discarded: true, existed: true });

    const payload = parse(
      await deckPreviewDiscardTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload).toEqual({ success: true, discarded: true });
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: Record<string, unknown>;
    };
    expect(audit.action).toBe('DELETE');
    expect(audit.data).toMatchObject({ tool: 'deck_preview_discard', existed: true });
  });

  it('is tolerant of an already-gone preview (still success, with a note)', async () => {
    mocks.discardDeckPreview.mockResolvedValue({ discarded: true, existed: false });

    const payload = parse(
      await deckPreviewDiscardTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      success: true,
      discarded: true,
      note: expect.stringMatching(/already gone/),
    });
  });
});
