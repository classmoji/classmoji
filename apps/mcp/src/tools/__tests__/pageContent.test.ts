/**
 * Unit tests for the page content tools (content-tools plan Phase 2, §9 P2):
 * page_content_outline / page_content_get / page_content_apply +
 * page_preview_accept / page_preview_discard, plus page_asset_upload /
 * page_cover_set (issue #369).
 *
 * Focus: S1 scoping (cross-classroom → scopedNotFound, no GitHub touch), the
 * optimistic lock (stale sha → CONTENT_CONFLICT, never a clobber), preview
 * routing (draft→direct vs published→preview defaults, explicit overrides,
 * stacking onto an existing branch), legacy-HTML refusal + replace_all escape
 * hatch, and enriched audit rows. For the cover pair: upload validation before
 * any GitHub call, the stored-ref/display-url split, and the cover write going
 * to the LIVE page rather than a preview branch.
 *
 * `@classmoji/services` is mocked, EXCEPT the pure pageContent helpers
 * (previewBranchName / ensureBlockIds / applyBlockOps) which are the real
 * implementations — the tools' outline/apply behavior is only meaningful
 * against the real block semantics. ContentService is stubbed out underneath
 * so importing the real service module never touches git/prisma providers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  pageFindById: vi.fn(),
  pageQuickUpdate: vi.fn(),
  loadPageContent: vi.fn(),
  savePageContent: vi.fn(),
  getPreviewStatus: vi.fn(),
  ensurePreviewBranch: vi.fn(),
  acceptPreview: vi.fn(),
  resolvePreviewConflicts: vi.fn(),
  discardPreview: vi.fn(),
  uploadPageAsset: vi.fn(),
  resolvePageAssetUrl: vi.fn(),
  auditCreate: vi.fn(),
}));

// Stub ContentService BEFORE the real pageContent.service module loads, so
// importActual below never drags in the git-provider/octokit/prisma chain.
vi.mock('../../../../../packages/services/src/content/ContentService.ts', () => ({
  ContentService: {},
}));

vi.mock('@classmoji/services', async () => {
  const pure = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/pageContent.service.ts')
  >('../../../../../packages/services/src/classmoji/pageContent.service.ts');
  // Upload validation is pure and shared with ContentService — the tool must
  // enforce the SAME 5 MB / extension rules, so use the real ones.
  const files = await vi.importActual<
    typeof import('../../../../../packages/services/src/content/utils/validateFile.ts')
  >('../../../../../packages/services/src/content/utils/validateFile.ts');
  return {
    validateFile: files.validateFile,
    MAX_FILE_SIZE: files.MAX_FILE_SIZE,
    ClassmojiService: {
      page: {
        findById: (...a: unknown[]) => mocks.pageFindById(...a),
        quickUpdate: (...a: unknown[]) => mocks.pageQuickUpdate(...a),
      },
      pageContent: {
        // Real pure helpers — the tools' semantics depend on them.
        previewBranchName: pure.previewBranchName,
        ensureBlockIds: pure.ensureBlockIds,
        applyBlockOps: pure.applyBlockOps,
        blankPageBlocks: pure.blankPageBlocks,
        // GitHub-touching helpers — mocked.
        loadPageContent: (...a: unknown[]) => mocks.loadPageContent(...a),
        savePageContent: (...a: unknown[]) => mocks.savePageContent(...a),
        getPreviewStatus: (...a: unknown[]) => mocks.getPreviewStatus(...a),
        ensurePreviewBranch: (...a: unknown[]) => mocks.ensurePreviewBranch(...a),
        acceptPreview: (...a: unknown[]) => mocks.acceptPreview(...a),
        resolvePreviewConflicts: (...a: unknown[]) => mocks.resolvePreviewConflicts(...a),
        discardPreview: (...a: unknown[]) => mocks.discardPreview(...a),
        uploadPageAsset: (...a: unknown[]) => mocks.uploadPageAsset(...a),
        resolvePageAssetUrl: (...a: unknown[]) => mocks.resolvePageAssetUrl(...a),
      },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
  };
});

const {
  pageContentOutlineTool,
  pageContentGetTool,
  pageContentApplyTool,
  pageAssetUploadTool,
  pageCoverSetTool,
  pagePreviewAcceptTool,
  pagePreviewDiscardTool,
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

/** Published page (is_draft false) — applies default to the preview branch. */
const PAGE = {
  id: PAGE_ID,
  classroom_id: 'class-1',
  title: 'Syllabus',
  slug: 'syllabus',
  content_path: 'pages/syllabus',
  is_draft: false,
  classroom: {
    id: 'class-1',
    content_repo: 'content-test-org-cs101',
    git_organization: { provider: 'GITHUB', login: 'test-org' },
  },
};

const DRAFT_PAGE = { ...PAGE, is_draft: true };

/** A real 1×1 transparent PNG, base64 — valid alphabet, no line breaks. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const STORED_COVER = { url: 'pages/syllabus/assets/1700000000000-hero.png', position: 30 };
const SIGNED_COVER_URL = 'https://content.classmoji.io/c/class-1/blob-sha.png?sig=abc';

const LONG_TEXT =
  'This heading text is deliberately far longer than the eighty character preview budget ' +
  'so the outline must truncate it with an ellipsis marker';

/** BlockNote doc: 4 blocks total, one nested, one missing its id. */
const DOC = () => [
  { id: 'h1', type: 'heading', content: [{ type: 'text', text: LONG_TEXT }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Short intro' }] }, // no id → derived
  {
    id: 'list',
    type: 'bulletListItem',
    content: [{ type: 'text', text: 'top item' }],
    children: [
      { id: 'nested', type: 'bulletListItem', content: [{ type: 'text', text: 'nested item' }] },
    ],
  },
];

const jsonContent = (blocks: unknown[] = DOC(), sha = 'sha-1') => ({
  format: 'json',
  blocks,
  coverImage: null,
  sha,
});

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.pageFindById.mockResolvedValue(PAGE);
  mocks.getPreviewStatus.mockResolvedValue({ exists: false });
  mocks.loadPageContent.mockResolvedValue(jsonContent());
  mocks.savePageContent.mockResolvedValue({ sha: 'new-sha', commit: 'commit-sha' });
  mocks.ensurePreviewBranch.mockResolvedValue({ branch: PREVIEW_BRANCH, created: true });
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.pageQuickUpdate.mockResolvedValue(undefined);
  mocks.uploadPageAsset.mockResolvedValue({
    url: 'pages/syllabus/assets/1700000000000-hero.png',
    path: 'pages/syllabus/assets/1700000000000-hero.png',
    sha: 'blob-sha',
    displayUrl: 'https://content.classmoji.io/c/class-1/blob-sha.png?sig=abc',
  });
  mocks.resolvePageAssetUrl.mockResolvedValue(
    'https://content.classmoji.io/c/class-1/blob-sha.png?sig=abc'
  );
});

// ─── S1: cross-classroom pages are invisible to every tool ──────────────────

describe('S1 classroom scoping', () => {
  const attempts: Array<[string, () => Promise<unknown>]> = [
    [
      'page_content_outline',
      () => pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX),
    ],
    [
      'page_content_get',
      () => pageContentGetTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX),
    ],
    [
      'page_content_apply',
      () =>
        pageContentApplyTool.handler(
          {
            classroom: 'org/x',
            page_id: PAGE_ID,
            expected_sha: 'sha-1',
            ops: [{ op: 'delete', id: 'h1' }],
          },
          CTX
        ),
    ],
    [
      'page_asset_upload',
      () =>
        pageAssetUploadTool.handler(
          {
            classroom: 'org/x',
            page_id: PAGE_ID,
            filename: 'hero.png',
            content_base64: PNG_BASE64,
          },
          CTX
        ),
    ],
    [
      'page_cover_set',
      () =>
        pageCoverSetTool.handler(
          { classroom: 'org/x', page_id: PAGE_ID, url: 'pages/syllabus/assets/hero.png' },
          CTX
        ),
    ],
    [
      'page_preview_accept',
      () => pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX),
    ],
    [
      'page_preview_discard',
      () => pagePreviewDiscardTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX),
    ],
  ];

  it.each(attempts)(
    '%s rejects a foreign page with scopedNotFound and never touches GitHub',
    async (_name, run) => {
      mocks.pageFindById.mockResolvedValue({ ...PAGE, classroom_id: 'OTHER-classroom' });

      await expect(run()).rejects.toMatchObject({ kind: 'not_found' });

      // Loaded with the classroom chain, then rejected — no content service call.
      expect(mocks.pageFindById).toHaveBeenCalledWith(PAGE_ID, { includeClassroom: true });
      for (const fn of [
        mocks.loadPageContent,
        mocks.savePageContent,
        mocks.acceptPreview,
        mocks.discardPreview,
        mocks.ensurePreviewBranch,
        mocks.uploadPageAsset,
        mocks.auditCreate,
      ]) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  );

  it('treats a missing page identically (non-leaking)', async () => {
    mocks.pageFindById.mockResolvedValue(null);
    await expect(
      pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

// ─── page_content_outline ────────────────────────────────────────────────────

describe('page_content_outline', () => {
  it('returns truncated previews, depth, children_count, and derived stable ids', async () => {
    const payload = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      format: 'json',
      sha: 'sha-1',
      sha_source: 'content_json',
      block_count: 4,
      has_cover_image: false,
      preview: { exists: false },
    });

    const [heading, intro, list, nested] = payload.blocks;

    // ≤80-char preview with ellipsis; the source text is far longer.
    expect(heading.id).toBe('h1');
    expect(heading.preview.length).toBe(80);
    expect(heading.preview.endsWith('…')).toBe(true);
    expect(heading.preview.startsWith('This heading text is deliberately')).toBe(true);
    expect(heading.depth).toBe(0);
    expect(heading.children_count).toBe(0);

    // Missing id filled deterministically WITHOUT writing.
    expect(intro.id).toMatch(/^b[0-9a-f]{10}$/);
    expect(intro.preview).toBe('Short intro');

    expect(list).toMatchObject({ id: 'list', depth: 0, children_count: 1 });
    expect(nested).toMatchObject({ id: 'nested', depth: 1, children_count: 0 });

    // Sha-bearing read — must bypass the cache.
    expect(mocks.loadPageContent.mock.calls[0][1]).toMatchObject({ skipCache: true });
  });

  it('derived ids are STABLE: outline twice yields identical ids', async () => {
    mocks.loadPageContent.mockResolvedValue(jsonContent(DOC()));
    const first = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    mocks.loadPageContent.mockResolvedValue(jsonContent(DOC()));
    const second = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(second.blocks.map((b: { id: string }) => b.id)).toEqual(
      first.blocks.map((b: { id: string }) => b.id)
    );
  });

  it('legacy HTML page: format html, no blocks, migration guidance', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'html',
      blocks: '<h1>Legacy</h1>',
      coverImage: null,
      sha: 'html-sha',
    });

    const payload = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      format: 'html',
      sha: 'html-sha',
      sha_source: 'legacy_html',
      block_count: 0,
      blocks: [],
    });
    expect(payload.message).toMatch(/legacy HTML/);
    expect(payload.message).toMatch(/replace_all/);
  });

  it('reports a pending preview with commits_ahead and age', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    mocks.getPreviewStatus.mockResolvedValue({
      exists: true,
      commits_ahead: 2,
      oldest_commit_at: twoHoursAgo,
    });

    const payload = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload.preview).toMatchObject({ exists: true, commits_ahead: 2, age: '2h' });
  });

  it("at: 'preview' reads FROM the preview branch", async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });

    await pageContentOutlineTool.handler(
      { classroom: 'org/x', page_id: PAGE_ID, at: 'preview' },
      CTX
    );

    expect(mocks.loadPageContent.mock.calls[0][1]).toMatchObject({
      skipCache: true,
      ref: PREVIEW_BRANCH,
    });
  });

  it("at: 'preview' without a pending preview is invalid_params", async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: false });

    await expect(
      pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID, at: 'preview' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.loadPageContent).not.toHaveBeenCalled();
  });
});

// ─── page_content_get ────────────────────────────────────────────────────────

describe('page_content_get', () => {
  it('returns the whole doc with normalized ids and the sha', async () => {
    const payload = parse(
      await pageContentGetTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      format: 'json',
      sha: 'sha-1',
      sha_source: 'content_json',
      block_count: 4,
    });
    expect(payload.blocks).toHaveLength(3); // top-level (nested rides inside)
    expect(payload.blocks[1].id).toMatch(/^b[0-9a-f]{10}$/); // normalized
    expect(payload.warning).toBeUndefined();
  });

  it('fetches a subset by block_ids, reaching nested blocks', async () => {
    const payload = parse(
      await pageContentGetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, block_ids: ['nested', 'h1'] },
        CTX
      )
    );

    expect(payload.blocks).toHaveLength(2);
    expect(payload.blocks[0].id).toBe('nested');
    expect(payload.blocks[1].id).toBe('h1');
    expect(payload.block_count).toBe(4); // whole-doc count still reported
  });

  it('names an unknown block id (invalid_params)', async () => {
    await expect(
      pageContentGetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, block_ids: ['ghost'] },
        CTX
      )
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining("'ghost'"),
    });
  });

  it('warns on whole-doc reads of large documents (≥100 blocks)', async () => {
    const big = Array.from({ length: 120 }, (_, i) => ({
      id: `p${i}`,
      type: 'paragraph',
      content: [{ type: 'text', text: `Block ${i}` }],
    }));
    mocks.loadPageContent.mockResolvedValue(jsonContent(big, 'big-sha'));

    const whole = parse(
      await pageContentGetTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(whole.warning).toMatch(/120 blocks/);

    const subset = parse(
      await pageContentGetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, block_ids: ['p3'] },
        CTX
      )
    );
    expect(subset.warning).toBeUndefined();
  });

  it('legacy HTML page: returns the html with guidance instead of blocks', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'html',
      blocks: '<h1>Legacy</h1>',
      coverImage: null,
      sha: 'html-sha',
    });

    const payload = parse(
      await pageContentGetTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      format: 'html',
      sha: 'html-sha',
      sha_source: 'legacy_html',
      html: '<h1>Legacy</h1>',
    });
    expect(payload.message).toMatch(/legacy HTML/);
  });
});

// ─── page_content_apply ──────────────────────────────────────────────────────

const APPLY_ARGS = {
  classroom: 'org/x',
  page_id: PAGE_ID,
  expected_sha: 'sha-1',
  ops: [
    {
      op: 'update' as const,
      id: 'h1',
      block: { type: 'heading', content: [{ type: 'text', text: 'New title' }] },
    },
  ],
};

describe('page_content_apply', () => {
  it('published page defaults to the preview branch (ensured, then committed to)', async () => {
    const payload = parse(await pageContentApplyTool.handler(APPLY_ARGS, CTX));

    expect(payload).toMatchObject({
      success: true,
      new_sha: 'new-sha',
      committed_to: 'preview',
      block_count: 4,
      applied: [{ op: 'update', id: 'h1' }],
    });

    // No existing preview → loaded from main (no ref), branch ensured, save on branch.
    expect(mocks.loadPageContent.mock.calls[0][1]).toEqual({ skipCache: true });
    expect(mocks.ensurePreviewBranch).toHaveBeenCalledTimes(1);
    const saveOpts = mocks.savePageContent.mock.calls[0][2] as Record<string, unknown>;
    expect(saveOpts).toMatchObject({ expectedSha: 'sha-1', branch: PREVIEW_BRANCH });

    // The updated block landed (id preserved through the update op).
    const savedBlocks = mocks.savePageContent.mock.calls[0][1] as Array<{
      id: string;
      content: Array<{ text: string }>;
    }>;
    expect(savedBlocks[0].id).toBe('h1');
    expect(savedBlocks[0].content[0].text).toBe('New title');
  });

  it('draft page defaults to a direct commit on main', async () => {
    mocks.pageFindById.mockResolvedValue(DRAFT_PAGE);

    const payload = parse(await pageContentApplyTool.handler(APPLY_ARGS, CTX));

    expect(payload.committed_to).toBe('main');
    expect(mocks.getPreviewStatus).not.toHaveBeenCalled();
    expect(mocks.ensurePreviewBranch).not.toHaveBeenCalled();
    const saveOpts = mocks.savePageContent.mock.calls[0][2] as Record<string, unknown>;
    expect(saveOpts.branch).toBeUndefined();
    expect(saveOpts.expectedSha).toBe('sha-1');
  });

  it("explicit commit overrides both defaults ('direct' on published, 'preview' on draft)", async () => {
    // Published + direct → main.
    let payload = parse(
      await pageContentApplyTool.handler({ ...APPLY_ARGS, commit: 'direct' as const }, CTX)
    );
    expect(payload.committed_to).toBe('main');
    expect(mocks.ensurePreviewBranch).not.toHaveBeenCalled();

    // Draft + preview → preview branch.
    mocks.pageFindById.mockResolvedValue(DRAFT_PAGE);
    payload = parse(
      await pageContentApplyTool.handler({ ...APPLY_ARGS, commit: 'preview' as const }, CTX)
    );
    expect(payload.committed_to).toBe('preview');
    expect(mocks.ensurePreviewBranch).toHaveBeenCalledTimes(1);
  });

  it('stacks onto an EXISTING preview: loads from the branch it will commit to', async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });

    await pageContentApplyTool.handler(APPLY_ARGS, CTX);

    expect(mocks.loadPageContent.mock.calls[0][1]).toMatchObject({
      skipCache: true,
      ref: PREVIEW_BRANCH,
    });
    const saveOpts = mocks.savePageContent.mock.calls[0][2] as Record<string, unknown>;
    expect(saveOpts.branch).toBe(PREVIEW_BRANCH);
  });

  it('stale expected_sha → CONTENT_CONFLICT, and the write never happens', async () => {
    await expect(
      pageContentApplyTool.handler({ ...APPLY_ARGS, expected_sha: 'stale-sha' }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'CONTENT_CONFLICT',
      message: expect.stringContaining('page_content_get'),
    });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a 409 from the save (race after our read) also maps to CONTENT_CONFLICT', async () => {
    mocks.savePageContent.mockRejectedValue(
      Object.assign(new Error('File was modified by someone else'), { status: 409 })
    );

    await expect(pageContentApplyTool.handler(APPLY_ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'CONTENT_CONFLICT',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a 409 after THIS apply created the branch deletes the fresh (empty) preview', async () => {
    mocks.ensurePreviewBranch.mockResolvedValue({ branch: PREVIEW_BRANCH, created: true });
    mocks.savePageContent.mockRejectedValue(
      Object.assign(new Error('File was modified by someone else'), { status: 409 })
    );

    await expect(pageContentApplyTool.handler(APPLY_ARGS, CTX)).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
    });
    expect(mocks.discardPreview).toHaveBeenCalledTimes(1);
  });

  it('a 409 while STACKING keeps the pre-existing preview branch and names the preview re-read', async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });
    mocks.ensurePreviewBranch.mockResolvedValue({ branch: PREVIEW_BRANCH, created: false });
    mocks.savePageContent.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));

    await expect(pageContentApplyTool.handler(APPLY_ARGS, CTX)).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      message: expect.stringContaining("at: 'preview'"),
    });
    expect(mocks.discardPreview).not.toHaveBeenCalled();
  });

  it('non-stacking conflict messages do NOT point at the preview', async () => {
    await expect(
      pageContentApplyTool.handler({ ...APPLY_ARGS, expected_sha: 'stale-sha' }, CTX)
    ).rejects.toMatchObject({
      code: 'CONTENT_CONFLICT',
      message: expect.not.stringContaining("at: 'preview'"),
    });
  });

  it('create path (no content file yet): saves WITHOUT an expectedSha lock', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'none',
      blocks: null,
      coverImage: null,
      sha: null,
    });

    const payload = parse(
      await pageContentApplyTool.handler(
        {
          ...APPLY_ARGS,
          commit: 'direct' as const,
          ops: [
            {
              op: 'replace_all' as const,
              blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }],
            },
          ],
        },
        CTX
      )
    );

    expect(payload).toMatchObject({ success: true, block_count: 1 });
    const saveOpts = mocks.savePageContent.mock.calls[0][2] as Record<string, unknown>;
    // A sha-less create: put() would 409 any expectedSha against a missing
    // file, so the lock is GitHub's own create semantics (422 on existence).
    expect(saveOpts.expectedSha).toBeUndefined();
  });

  it('create race: a 422 from the sha-less create maps to CONTENT_CONFLICT', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'none',
      blocks: null,
      coverImage: null,
      sha: null,
    });
    mocks.savePageContent.mockRejectedValue(
      Object.assign(new Error('Invalid request. "sha" wasn\'t supplied.'), { status: 422 })
    );

    await expect(
      pageContentApplyTool.handler(
        {
          ...APPLY_ARGS,
          commit: 'direct' as const,
          ops: [{ op: 'replace_all' as const, blocks: [] }],
        },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params', code: 'CONTENT_CONFLICT' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a 422 when content DID exist is not swallowed as a conflict', async () => {
    mocks.savePageContent.mockRejectedValue(
      Object.assign(new Error('Validation Failed'), { status: 422 })
    );

    await expect(pageContentApplyTool.handler(APPLY_ARGS, CTX)).rejects.toMatchObject({
      message: expect.stringContaining('Validation Failed'),
    });
  });

  it('reports deterministic id re-mints for colliding client-supplied ids', async () => {
    const payload = parse(
      await pageContentApplyTool.handler(
        {
          ...APPLY_ARGS,
          ops: [
            {
              op: 'insert' as const,
              // 'h1' collides with the existing heading block's id.
              blocks: [{ id: 'h1', type: 'paragraph', content: [] }],
              position: { at: 'end' as const },
            },
          ],
        },
        CTX
      )
    );

    expect(payload.applied[0]).toMatchObject({
      op: 'insert',
      reminted_ids: [{ from: 'h1', to: expect.stringMatching(/^b[0-9a-f]{10}$/) }],
    });
    // The saved doc has no duplicate ids.
    const savedBlocks = mocks.savePageContent.mock.calls[0][1] as Array<{ id: string }>;
    const ids = savedBlocks.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('unknown block id in an op → invalid_params naming it, no write', async () => {
    await expect(
      pageContentApplyTool.handler(
        { ...APPLY_ARGS, ops: [{ op: 'delete' as const, id: 'ghost' }] },
        CTX
      )
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining("'ghost'"),
    });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('legacy HTML page refuses granular ops with migration guidance', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'html',
      blocks: '<h1>Legacy</h1>',
      coverImage: null,
      sha: 'html-sha',
    });

    await expect(
      pageContentApplyTool.handler({ ...APPLY_ARGS, expected_sha: 'html-sha' }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringMatching(/legacy HTML/),
    });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('legacy HTML page allows replace_all (fresh wrapper, ids filled, sha still checked)', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'html',
      blocks: '<h1>Legacy</h1>',
      coverImage: null,
      sha: 'html-sha',
    });

    const payload = parse(
      await pageContentApplyTool.handler(
        {
          ...APPLY_ARGS,
          expected_sha: 'html-sha',
          commit: 'direct' as const,
          ops: [
            {
              op: 'replace_all' as const,
              blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fresh' }] }],
            },
          ],
        },
        CTX
      )
    );

    expect(payload).toMatchObject({ success: true, committed_to: 'main', block_count: 1 });
    const savedBlocks = mocks.savePageContent.mock.calls[0][1] as Array<{ id: string }>;
    expect(savedBlocks[0].id).toMatch(/^b[0-9a-f]{10}$/); // ids persisted on first apply

    // And a STALE sha against the html file still conflicts.
    mocks.savePageContent.mockClear();
    await expect(
      pageContentApplyTool.handler(
        {
          ...APPLY_ARGS,
          expected_sha: 'stale',
          ops: [{ op: 'replace_all' as const, blocks: [] }],
        },
        CTX
      )
    ).rejects.toMatchObject({ code: 'CONTENT_CONFLICT' });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('writes ONE enriched audit row per apply', async () => {
    await pageContentApplyTool.handler(
      {
        ...APPLY_ARGS,
        ops: [
          { op: 'update' as const, id: 'h1', block: { type: 'heading', content: [] } },
          { op: 'delete' as const, id: 'list' },
          {
            op: 'insert' as const,
            blocks: [{ type: 'paragraph', content: [] }],
            position: { at: 'end' as const },
          },
        ],
      },
      CTX
    );

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      resource_type: string;
      resource_id: string;
      action: string;
      data: Record<string, unknown>;
    };
    expect(audit).toMatchObject({
      resource_type: 'PAGES',
      resource_id: PAGE_ID,
      action: 'UPDATE',
    });
    expect(audit.data).toMatchObject({
      tool: 'page_content_apply',
      ops: [
        { op: 'update', id: 'h1' },
        { op: 'delete', id: 'list' },
        { op: 'insert', count: 1 },
      ],
      expected_sha: 'sha-1',
      new_sha: 'new-sha',
      commit_sha: 'commit-sha',
      committed_to: 'preview',
      prior_block_count: 4, // delete op present → prior count recorded
    });
  });

  it('omits prior_block_count when no destructive op is present', async () => {
    await pageContentApplyTool.handler(APPLY_ARGS, CTX);
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect('prior_block_count' in audit.data).toBe(false);
  });
});

// ─── page_preview_accept ─────────────────────────────────────────────────────

describe('page_preview_accept', () => {
  it('refuses when no preview exists (nothing to accept)', async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: false });

    await expect(
      pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.acceptPreview).not.toHaveBeenCalled();
  });

  it('clean merge: success payload + audit', async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.acceptPreview.mockResolvedValue({ merged: true, sha: 'merge-sha' });

    const payload = parse(
      await pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toEqual({ success: true, merged: true, new_sha: 'merge-sha' });
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: Record<string, unknown>;
    };
    expect(audit.action).toBe('UPDATE');
    expect(audit.data).toMatchObject({
      tool: 'page_preview_accept',
      outcome: 'merged',
      new_sha: 'merge-sha',
    });
  });

  it('preview_kept (concurrent stacking apply during accept) surfaces in payload + audit', async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.acceptPreview.mockResolvedValue({
      merged: true,
      sha: 'merged-blob-sha',
      preview_kept: true,
      reason: 'Preview branch gained 1 new commit(s) during accept — retained with the newer edits',
    });

    const payload = parse(
      await pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      success: true,
      merged: true,
      new_sha: 'merged-blob-sha',
      preview_kept: true,
      message: expect.stringContaining('preview branch was retained'),
    });

    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({ preview_kept: true, reason: expect.any(String) });
  });

  it('conflict: structured per-unit report as a NON-error payload, with guidance + audit', async () => {
    const units = [
      { id: 'h1', index: 0, ours: { id: 'h1' }, theirs: { id: 'h1' }, base: { id: 'h1' } },
    ];
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.acceptPreview.mockResolvedValue({
      merged: false,
      conflict: true,
      units,
      auto_merged: 5,
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });

    const result = await pagePreviewAcceptTool.handler(
      { classroom: 'org/x', page_id: PAGE_ID },
      CTX
    );
    expect(result.isError).toBeUndefined(); // ok() payload, not a tool error
    const payload = parse(result);

    expect(payload).toMatchObject({
      conflict: true,
      units,
      auto_merged: 5,
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });
    expect(payload.message).toMatch(/page_content_get/);
    expect(payload.message).toMatch(/page_preview_discard/);
    // The report teaches the resolutions path and names the counts.
    expect(payload.message).toMatch(/resolutions/);
    expect(payload.message).toContain('5 change(s) auto-merge cleanly');
    expect(payload.message).toContain('1 conflict(s)');

    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({
      tool: 'page_preview_accept',
      outcome: 'conflict',
      conflict_unit_ids: ['h1'],
      auto_merged: 5,
      ours_sha: 'ours-sha',
      theirs_sha: 'theirs-sha',
    });
  });

  it('a semantic auto-merge surfaces semantic + auto_merged in payload and audit', async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.acceptPreview.mockResolvedValue({
      merged: true,
      semantic: true,
      auto_merged: 7,
      sha: 'merge-sha',
    });

    const payload = parse(
      await pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toEqual({
      success: true,
      merged: true,
      semantic: true,
      auto_merged: 7,
      new_sha: 'merge-sha',
    });
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({ outcome: 'merged', semantic: true, auto_merged: 7 });
  });

  it('a 409 during the semantic merge maps to CONTENT_CONFLICT', async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 1 });
    mocks.acceptPreview.mockRejectedValue(
      Object.assign(new Error('File was modified'), { status: 409 })
    );

    await expect(
      pagePreviewAcceptTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'CONTENT_CONFLICT',
      message: expect.stringContaining('page_preview_accept'),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

// ─── page_preview_accept — resolutions ───────────────────────────────────────

describe('page_preview_accept with resolutions', () => {
  const RESOLUTIONS = [
    { id: 'h1', choose: 'ours' as const },
    { id: '__order__', choose: 'theirs' as const },
  ];

  beforeEach(() => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: true, commits_ahead: 2 });
    mocks.resolvePreviewConflicts.mockResolvedValue({
      merged: true,
      semantic: true,
      auto_merged: 4,
      resolved: RESOLUTIONS,
      sha: 'resolved-sha',
    });
  });

  it('routes to resolvePreviewConflicts and audits the choices', async () => {
    const payload = parse(
      await pagePreviewAcceptTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, resolutions: RESOLUTIONS },
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
    });

    expect(mocks.acceptPreview).not.toHaveBeenCalled();
    expect(mocks.resolvePreviewConflicts).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePreviewConflicts.mock.calls[0][1]).toEqual({ resolutions: RESOLUTIONS });

    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({
      tool: 'page_preview_accept',
      outcome: 'merged',
      semantic: true,
      resolutions: RESOLUTIONS,
      auto_merged: 4,
      new_sha: 'resolved-sha',
    });
  });

  it('maps PreviewResolutionError to invalid_params carrying its code AND ids — no audit', async () => {
    mocks.resolvePreviewConflicts.mockRejectedValue(
      Object.assign(new Error('Every conflict needs a choice — missing: p2'), {
        name: 'PreviewResolutionError',
        code: 'UNRESOLVED_CONFLICTS',
        ids: ['p2'],
      })
    );

    await expect(
      pagePreviewAcceptTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, resolutions: RESOLUTIONS },
        CTX
      )
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'UNRESOLVED_CONFLICTS',
      data: { ids: ['p2'] },
      message: expect.stringContaining('p2'),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('passes expected_ours_sha/expected_theirs_sha through to the resolve service (F3)', async () => {
    await pagePreviewAcceptTool.handler(
      {
        classroom: 'org/x',
        page_id: PAGE_ID,
        resolutions: RESOLUTIONS,
        expected_ours_sha: 'report-ours-sha',
        expected_theirs_sha: 'report-theirs-sha',
      },
      CTX
    );

    expect(mocks.resolvePreviewConflicts.mock.calls[0][1]).toEqual({
      resolutions: RESOLUTIONS,
      expectedOursSha: 'report-ours-sha',
      expectedTheirsSha: 'report-theirs-sha',
    });
  });

  it('maps a stale sha pin (CONTENT_CONFLICT PreviewResolutionError) to the CONTENT_CONFLICT code', async () => {
    mocks.resolvePreviewConflicts.mockRejectedValue(
      Object.assign(new Error('The live page changed since the conflict report — re-run accept'), {
        name: 'PreviewResolutionError',
        code: 'CONTENT_CONFLICT',
        ids: [],
      })
    );

    await expect(
      pagePreviewAcceptTool.handler(
        {
          classroom: 'org/x',
          page_id: PAGE_ID,
          resolutions: RESOLUTIONS,
          expected_ours_sha: 'stale',
        },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params', code: 'CONTENT_CONFLICT' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('still requires a pending preview', async () => {
    mocks.getPreviewStatus.mockResolvedValue({ exists: false });

    await expect(
      pagePreviewAcceptTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, resolutions: RESOLUTIONS },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.resolvePreviewConflicts).not.toHaveBeenCalled();
  });
});

// ─── page_preview_discard ────────────────────────────────────────────────────

describe('page_preview_discard', () => {
  it('discards the preview and audits the deletion', async () => {
    mocks.discardPreview.mockResolvedValue({ discarded: true, existed: true });

    const payload = parse(
      await pagePreviewDiscardTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toEqual({ success: true, discarded: true });
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: Record<string, unknown>;
    };
    expect(audit.action).toBe('DELETE');
    expect(audit.data).toMatchObject({ tool: 'page_preview_discard', existed: true });
  });

  it('is tolerant of an already-gone preview (still success, with a note)', async () => {
    mocks.discardPreview.mockResolvedValue({ discarded: true, existed: false });

    const payload = parse(
      await pagePreviewDiscardTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload).toMatchObject({
      success: true,
      discarded: true,
      note: expect.stringMatching(/already gone/),
    });
  });
});

// ─── Cover image on the read side ────────────────────────────────────────────

describe('cover_image on reads', () => {
  it('outline reports the stored ref AND a resolved display_url', async () => {
    mocks.loadPageContent.mockResolvedValue({ ...jsonContent(), coverImage: STORED_COVER });

    const payload = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    // has_cover_image stays for compatibility; cover_image is the useful one.
    expect(payload.has_cover_image).toBe(true);
    expect(payload.cover_image).toEqual({
      url: STORED_COVER.url,
      display_url: SIGNED_COVER_URL,
      position: 30,
    });
    expect(mocks.resolvePageAssetUrl).toHaveBeenCalledWith(PAGE, STORED_COVER.url);
  });

  it('display_url is null when nothing can be signed — never the bare path', async () => {
    mocks.loadPageContent.mockResolvedValue({ ...jsonContent(), coverImage: STORED_COVER });
    mocks.resolvePageAssetUrl.mockResolvedValue(null);

    const payload = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload.cover_image).toEqual({
      url: STORED_COVER.url,
      display_url: null,
      position: 30,
    });
  });

  it('defaults a stored cover with no position to 50', async () => {
    mocks.loadPageContent.mockResolvedValue({
      ...jsonContent(),
      coverImage: { url: STORED_COVER.url },
    });

    const payload = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(payload.cover_image.position).toBe(50);
  });

  it('outline and get both report null when there is no cover', async () => {
    const outline = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    const got = parse(
      await pageContentGetTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );

    expect(outline.cover_image).toBeNull();
    expect(got.cover_image).toBeNull();
    expect(mocks.resolvePageAssetUrl).not.toHaveBeenCalled();
  });

  it('get carries cover_image on the block_ids path too', async () => {
    mocks.loadPageContent.mockResolvedValue({ ...jsonContent(), coverImage: STORED_COVER });

    const payload = parse(
      await pageContentGetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, block_ids: ['h1'] },
        CTX
      )
    );

    expect(payload.blocks).toHaveLength(1);
    expect(payload.cover_image).toMatchObject({ url: STORED_COVER.url, position: 30 });
  });

  it('a legacy HTML page reports cover_image null (nowhere to store one)', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'html',
      blocks: '<h1>Legacy</h1>',
      coverImage: null,
      sha: 'html-sha',
    });

    const payload = parse(
      await pageContentOutlineTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    );
    expect(payload.cover_image).toBeNull();
  });
});

// ─── page_asset_upload ───────────────────────────────────────────────────────

describe('page_asset_upload', () => {
  const upload = (args: Record<string, unknown> = {}) =>
    pageAssetUploadTool.handler(
      {
        classroom: 'org/x',
        page_id: PAGE_ID,
        filename: 'hero.png',
        content_base64: PNG_BASE64,
        ...args,
      } as never,
      CTX
    );

  it('commits the decoded bytes and returns the STORED ref plus a display url', async () => {
    const payload = parse(await upload());

    const [page, buffer, filename] = mocks.uploadPageAsset.mock.calls[0];
    expect(page).toBe(PAGE);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer).toEqual(Buffer.from(PNG_BASE64, 'base64'));
    expect(filename).toBe('hero.png');

    expect(payload).toEqual({
      success: true,
      path: 'pages/syllabus/assets/1700000000000-hero.png',
      url: 'pages/syllabus/assets/1700000000000-hero.png',
      display_url: SIGNED_COVER_URL,
      sha: 'blob-sha',
      size: buffer.length,
    });
  });

  it('audits the upload against the page', async () => {
    await upload();

    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        classroom_id: 'class-1',
        resource_type: 'PAGES',
        resource_id: PAGE_ID,
        action: 'UPDATE',
        data: expect.objectContaining({
          tool: 'page_asset_upload',
          path: 'pages/syllabus/assets/1700000000000-hero.png',
          sha: 'blob-sha',
        }),
      })
    );
  });

  it('accepts a whole data: URL, not just the payload', async () => {
    await upload({ content_base64: `data:image/png;base64,${PNG_BASE64}` });

    expect(mocks.uploadPageAsset.mock.calls[0][1]).toEqual(Buffer.from(PNG_BASE64, 'base64'));
  });

  it('refuses a disallowed extension BEFORE touching the repo', async () => {
    await expect(upload({ filename: 'notes.txt' })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('Invalid file type'),
    });
    expect(mocks.uploadPageAsset).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a file over the 5 MB cap, in bytes not characters', async () => {
    const oversize = Buffer.alloc(5 * 1024 * 1024 + 1024).toString('base64');

    await expect(upload({ content_base64: oversize })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('File too large'),
    });
    expect(mocks.uploadPageAsset).not.toHaveBeenCalled();

    // The schema's character cap is what stops the same payload one layer up,
    // before the bytes are ever decoded (handlers are called directly here).
    expect(pageAssetUploadTool.inputSchema.content_base64.safeParse(oversize).success).toBe(false);
    expect(pageAssetUploadTool.inputSchema.content_base64.safeParse(PNG_BASE64).success).toBe(true);
  });

  it('refuses garbage base64 rather than committing whatever decodes', async () => {
    await expect(upload({ content_base64: 'not base64 at all!!' })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('not valid base64'),
    });
    expect(mocks.uploadPageAsset).not.toHaveBeenCalled();
  });

  it('refuses base64 that decodes to nothing', async () => {
    await expect(upload({ content_base64: '' })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('zero bytes'),
    });
    expect(mocks.uploadPageAsset).not.toHaveBeenCalled();
  });
});

// ─── page_cover_set ──────────────────────────────────────────────────────────

describe('page_cover_set', () => {
  const setCover = (args: Record<string, unknown>) =>
    pageCoverSetTool.handler({ classroom: 'org/x', page_id: PAGE_ID, ...args } as never, CTX);

  const savedCover = () => mocks.savePageContent.mock.calls[0][2].coverImage;

  it('sets a cover, CAS-locked on the content sha, and stamps the page row', async () => {
    const existingBlocks = DOC();
    mocks.loadPageContent.mockResolvedValue(jsonContent(existingBlocks));

    const payload = parse(await setCover({ url: STORED_COVER.url, position: 20 }));

    const [page, blocks, options] = mocks.savePageContent.mock.calls[0];
    expect(page).toBe(PAGE);
    // Cover-only write: the blocks go back exactly as they were read — the same
    // array object, not a re-derived copy with fresh ids.
    expect(blocks).toBe(existingBlocks);
    expect(options).toMatchObject({
      coverImage: { url: STORED_COVER.url, position: 20 },
      expectedSha: 'sha-1',
    });
    // Never a preview branch — a cover change is live, like the web editor's.
    expect(options.branch).toBeUndefined();
    expect(mocks.loadPageContent.mock.calls[0][1]).toMatchObject({ skipCache: true });

    expect(mocks.pageQuickUpdate).toHaveBeenCalledWith(PAGE_ID, { updated_at: expect.any(Date) });
    expect(payload).toMatchObject({
      success: true,
      new_sha: 'new-sha',
      cover_image: { url: STORED_COVER.url, display_url: SIGNED_COVER_URL, position: 20 },
    });
  });

  it('defaults a brand-new cover to position 50', async () => {
    await setCover({ url: STORED_COVER.url });
    expect(savedCover()).toEqual({ url: STORED_COVER.url, position: 50 });
  });

  it('keeps the current position when only the image changes', async () => {
    mocks.loadPageContent.mockResolvedValue({ ...jsonContent(), coverImage: STORED_COVER });

    await setCover({ url: 'pages/syllabus/assets/other.jpg' });

    expect(savedCover()).toEqual({ url: 'pages/syllabus/assets/other.jpg', position: 30 });
  });

  it('repositions without a url, keeping the current image', async () => {
    mocks.loadPageContent.mockResolvedValue({ ...jsonContent(), coverImage: STORED_COVER });

    await setCover({ position: 80 });

    expect(savedCover()).toEqual({ url: STORED_COVER.url, position: 80 });
  });

  it('removes the cover on url: null', async () => {
    mocks.loadPageContent.mockResolvedValue({ ...jsonContent(), coverImage: STORED_COVER });

    const payload = parse(await setCover({ url: null }));

    expect(savedCover()).toBeNull();
    expect(payload.cover_image).toBeNull();
    expect(mocks.auditCreate.mock.calls[0][0].data).toMatchObject({
      removed: true,
      prior_url: STORED_COVER.url,
    });
  });

  it('removing an absent cover is an idempotent no-op — no commit at all', async () => {
    const payload = parse(await setCover({ url: null }));

    expect(payload).toMatchObject({ success: true, cover_image: null, unchanged: true });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
    expect(mocks.pageQuickUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a call that expresses no change', async () => {
    await expect(setCover({})).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.loadPageContent).not.toHaveBeenCalled();
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('refuses to reposition a cover that does not exist', async () => {
    await expect(setCover({ position: 80 })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('no cover image to reposition'),
    });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('refuses a non-image ref even though uploads allow .pdf', async () => {
    await expect(setCover({ url: 'pages/syllabus/assets/handout.pdf' })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('must be an image'),
    });
    expect(mocks.loadPageContent).not.toHaveBeenCalled();
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('ignores a query string when judging the extension', async () => {
    await setCover({ url: 'pages/syllabus/assets/hero.png?v=2' });
    expect(savedCover()).toMatchObject({ url: 'pages/syllabus/assets/hero.png?v=2' });
  });

  it('refuses a legacy HTML page instead of dropping its content', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'html',
      blocks: '<h1>Legacy</h1>',
      coverImage: null,
      sha: 'html-sha',
    });

    await expect(setCover({ url: STORED_COVER.url })).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('legacy HTML'),
    });
    expect(mocks.savePageContent).not.toHaveBeenCalled();
  });

  it('creates content.json with blank blocks (and no sha lock) for a page with no file', async () => {
    mocks.loadPageContent.mockResolvedValue({
      format: 'none',
      blocks: null,
      coverImage: null,
      sha: null,
    });

    await setCover({ url: STORED_COVER.url });

    const [, blocks, options] = mocks.savePageContent.mock.calls[0];
    expect(blocks).toEqual([expect.objectContaining({ type: 'paragraph' })]);
    expect(options.expectedSha).toBeUndefined();
  });

  it('maps a 409 to CONTENT_CONFLICT and leaves the page row alone', async () => {
    mocks.savePageContent.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));

    await expect(setCover({ url: STORED_COVER.url })).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'CONTENT_CONFLICT',
    });
    expect(mocks.pageQuickUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

// ─── Tool declarations ───────────────────────────────────────────────────────

describe('page asset/cover tool declarations', () => {
  const NEW_TOOLS = [pageAssetUploadTool, pageCoverSetTool];

  it('declares the write scope and the OWNER/TEACHER tier', () => {
    for (const tool of NEW_TOOLS) {
      expect(tool.scope).toBe('write');
      expect(tool.roles).toEqual(['OWNER', 'TEACHER']);
      expect(tool.inputSchema).toHaveProperty('classroom');
    }
  });

  it('annotates both as non-destructive but open-world (they commit to GitHub)', () => {
    for (const tool of NEW_TOOLS) {
      expect(tool.annotations).toMatchObject({ destructive: false, openWorld: true });
    }
    expect(pageCoverSetTool.annotations?.idempotent).toBe(true);
  });

  /** Same 1,500-byte ceiling forms.test.ts guards — the connector DROPS a tool over it. */
  it('keeps both descriptions well under the 2 KB a client will cut', () => {
    for (const tool of NEW_TOOLS) {
      expect(new TextEncoder().encode(tool.description).length).toBeLessThan(1500);
    }
  });
});
