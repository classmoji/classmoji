/**
 * Unit tests for the slide tools (content-tools plan Phase 5, §9 P5):
 * list_slides / slide_create / slide_update / slide_delete.
 *
 * Focus: S1 scoping (cross-classroom → scopedNotFound, no service touch),
 * the assertSlideEditable sub-gate matrix (OWNER/TEACHER pass via holdsRole,
 * ASSISTANT × creator × allow_team_edit, multi-role escape hatch), list_slides
 * role filtering (the whole teaching team sees drafts — the VIEW tier, wider
 * than the edit tier on purpose; students get the published-only list with the
 * minimal field set), delete's video-cleanup reporting, and audits.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  slideFindById: vi.fn(),
  findByClassroomId: vi.fn(),
  createSlide: vi.fn(),
  updateSlide: vi.fn(),
  deleteSlide: vi.fn(),
  auditCreate: vi.fn(),
  findMembership: vi.fn(),
}));

vi.mock('@classmoji/services/slides', () => ({
  slideService: {
    findById: (...a: unknown[]) => mocks.slideFindById(...a),
    findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a),
    createSlide: (...a: unknown[]) => mocks.createSlide(...a),
    updateSlide: (...a: unknown[]) => mocks.updateSlide(...a),
    deleteSlide: (...a: unknown[]) => mocks.deleteSlide(...a),
    SLIDE_CONTENT_PATH_CONFLICT: 'SLIDE_CONTENT_PATH_CONFLICT',
    STARTER_CUSTOM_CSS: 'STARTER_CSS',
  },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findMembership(...a),
    },
  },
}));

const { listSlidesTool, slideCreateTool, slideUpdateTool, slideDeleteTool } =
  await import('../slides.ts');

const SLIDE_ID = '22222222-2222-4222-8222-222222222222';

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

const TEACHER_CTX = makeCtx('TEACHER', 'teacher-1');
const ASSISTANT_CTX = makeCtx('ASSISTANT', 'ta-1');

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
    content_repo: 'content-test-org-cs101',
    git_organization: { provider: 'GITHUB', login: 'test-org' },
  },
};

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.slideFindById.mockResolvedValue(SLIDE);
  mocks.findMembership.mockResolvedValue(null);
  mocks.updateSlide.mockImplementation((_id: string, data: Record<string, unknown>) =>
    Promise.resolve({ ...SLIDE, ...data })
  );
  mocks.deleteSlide.mockResolvedValue({
    success: true,
    themeName: null,
    themeDeleted: false,
    otherSlidesUsingTheme: 0,
  });
  mocks.auditCreate.mockResolvedValue(undefined);
});

// ─── S1: cross-classroom slides are invisible ───────────────────────────────

describe('S1 classroom scoping', () => {
  const attempts: Array<[string, () => Promise<unknown>]> = [
    [
      'slide_update',
      () =>
        slideUpdateTool.handler(
          { classroom: 'org/x', slide_id: SLIDE_ID, is_draft: false },
          TEACHER_CTX
        ),
    ],
    [
      'slide_delete',
      () => slideDeleteTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, TEACHER_CTX),
    ],
  ];

  it.each(attempts)(
    '%s rejects a foreign slide with scopedNotFound and never mutates',
    async (_name, run) => {
      mocks.slideFindById.mockResolvedValue({ ...SLIDE, classroom_id: 'OTHER-classroom' });

      await expect(run()).rejects.toMatchObject({ kind: 'not_found' });

      expect(mocks.slideFindById).toHaveBeenCalledWith(SLIDE_ID, { includeClassroom: true });
      for (const fn of [mocks.updateSlide, mocks.deleteSlide, mocks.auditCreate]) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  );

  it('treats a missing slide identically (non-leaking)', async () => {
    mocks.slideFindById.mockResolvedValue(null);
    await expect(
      slideUpdateTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, is_draft: true },
        TEACHER_CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('a classroom without a git org is an internal misconfiguration (post-S1)', async () => {
    mocks.slideFindById.mockResolvedValue({
      ...SLIDE,
      classroom: { ...SLIDE.classroom, git_organization: null },
    });
    await expect(
      slideUpdateTool.handler(
        { classroom: 'org/x', slide_id: SLIDE_ID, is_draft: true },
        TEACHER_CTX
      )
    ).rejects.toMatchObject({ kind: 'internal' });
  });
});

// ─── assertSlideEditable matrix (via slide_update) ──────────────────────────

describe('assertSlideEditable sub-gate', () => {
  const update = (ctx: ToolContext) =>
    slideUpdateTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID, is_draft: false }, ctx);

  it('OWNER/TEACHER pass without a membership lookup (holdsRole short-circuit)', async () => {
    for (const ctx of [makeCtx('OWNER', 'o-1'), makeCtx('TEACHER', 'other-teacher')]) {
      mocks.updateSlide.mockClear();
      await update(ctx);
      expect(mocks.updateSlide).toHaveBeenCalledTimes(1);
    }
    expect(mocks.findMembership).not.toHaveBeenCalled();
  });

  it('ASSISTANT who created the deck passes', async () => {
    mocks.slideFindById.mockResolvedValue({ ...SLIDE, created_by: 'ta-1' });
    await update(ASSISTANT_CTX);
    expect(mocks.updateSlide).toHaveBeenCalledTimes(1);
  });

  it("ASSISTANT on someone else's deck passes only with allow_team_edit", async () => {
    mocks.slideFindById.mockResolvedValue({ ...SLIDE, allow_team_edit: true });
    await update(ASSISTANT_CTX);
    expect(mocks.updateSlide).toHaveBeenCalledTimes(1);
  });

  it("ASSISTANT on someone else's locked deck is forbidden (no write, no audit)", async () => {
    await expect(update(ASSISTANT_CTX)).rejects.toMatchObject({
      kind: 'forbidden',
      code: 'INSUFFICIENT_ROLE',
    });
    // The OWNER/TEACHER escape hatch was consulted before denying.
    expect(mocks.findMembership).toHaveBeenCalledWith('class-1', 'ta-1', ['OWNER', 'TEACHER']);
    expect(mocks.updateSlide).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('multi-role: gate resolved as ASSISTANT but the caller also holds TEACHER → passes', async () => {
    mocks.findMembership.mockResolvedValue({ id: 'm-2', role: 'TEACHER' });
    await update(ASSISTANT_CTX);
    expect(mocks.updateSlide).toHaveBeenCalledTimes(1);
  });

  it('slide_delete enforces the same sub-gate', async () => {
    await expect(
      slideDeleteTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, ASSISTANT_CTX)
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.deleteSlide).not.toHaveBeenCalled();
  });
});

// ─── list_slides ─────────────────────────────────────────────────────────────

describe('list_slides', () => {
  const ROWS = [
    { ...SLIDE, id: 's-1', title: 'Published', is_draft: false },
    { ...SLIDE, id: 's-2', title: 'Draft', is_draft: true },
  ];

  // POLICY: the listing follows the VIEW tier, which is the whole teaching
  // team — including an ASSISTANT who neither created the draft nor has
  // allow_team_edit on it. Editing is the narrower tier and is pinned
  // separately by the assertSlideEditable suite above. If a change makes an
  // ASSISTANT fall into the published-only branch again, that is a policy
  // regression, not a test that needs updating.
  it.each([['OWNER'], ['TEACHER'], ['ASSISTANT']] as const)(
    '%s gets the full list incl. drafts, with visibility flags',
    async role => {
      mocks.findByClassroomId.mockResolvedValue(ROWS);

      const payload = parse(
        await listSlidesTool.handler({ classroom: 'org/x' }, makeCtx(role as 'OWNER'))
      );

      expect(mocks.findByClassroomId).toHaveBeenCalledWith('class-1', { includeDrafts: true });
      expect(payload.slides).toHaveLength(2);
      expect(payload.slides[0]).toMatchObject({
        id: 's-1',
        title: 'Published',
        slug: 'intro-week',
        is_draft: false,
        is_public: false,
        allow_team_edit: false,
        show_speaker_notes: false,
        created_by: 'teacher-1',
      });
      expect(payload.slides[1]).toMatchObject({ id: 's-2', title: 'Draft', is_draft: true });
    }
  );

  it('lists a draft to an ASSISTANT who is neither its creator nor covered by allow_team_edit', async () => {
    mocks.findByClassroomId.mockResolvedValue([
      { ...ROWS[1], created_by: 'someone-else', allow_team_edit: false },
    ]);

    const payload = parse(await listSlidesTool.handler({ classroom: 'org/x' }, ASSISTANT_CTX));

    expect(payload.slides).toHaveLength(1);
    expect(payload.slides[0]).toMatchObject({ id: 's-2', is_draft: true });
  });

  it('STUDENT gets the published-only list with the minimal field set', async () => {
    mocks.findByClassroomId.mockResolvedValue([ROWS[0]]);

    const payload = parse(await listSlidesTool.handler({ classroom: 'org/x' }, makeCtx('STUDENT')));

    expect(mocks.findByClassroomId).toHaveBeenCalledWith('class-1', { includeDrafts: false });
    expect(payload.slides).toHaveLength(1);
    expect(payload.slides[0]).toEqual({
      id: 's-1',
      title: 'Published',
      slug: 'intro-week',
      updated_at: expect.anything(),
    });
    // No draft/visibility internals reach a student.
    expect('is_draft' in payload.slides[0]).toBe(false);
    expect('allow_team_edit' in payload.slides[0]).toBe(false);
  });
});

// ─── slide_create ────────────────────────────────────────────────────────────

describe('slide_create', () => {
  it('creates via the orchestrated service and returns the deck sha for immediate applies', async () => {
    mocks.createSlide.mockResolvedValue({
      slide: { ...SLIDE, id: 'new-slide', title: 'New Deck', slug: 'new-deck', is_draft: true },
      deck: {},
      sha: 'starter-sha',
      commit: 'commit-1',
      html: '<html>',
    });

    const payload = parse(
      await slideCreateTool.handler({ classroom: 'org/x', title: 'New Deck' }, TEACHER_CTX)
    );

    expect(mocks.createSlide).toHaveBeenCalledWith({
      classroomId: 'class-1',
      title: 'New Deck',
      createdBy: 'teacher-1',
    });
    expect(payload).toMatchObject({
      success: true,
      slide: { id: 'new-slide', title: 'New Deck', is_draft: true },
      sha: 'starter-sha',
      sha_source: 'deck',
    });

    const audit = mocks.auditCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(audit).toMatchObject({
      resource_type: 'SLIDES',
      resource_id: 'new-slide',
      action: 'CREATE',
    });
  });

  it('maps the content-path collision to invalid_params', async () => {
    mocks.createSlide.mockRejectedValue(
      Object.assign(new Error("A slide deck already uses the content path 'slides/new-deck'"), {
        code: 'SLIDE_CONTENT_PATH_CONFLICT',
      })
    );

    await expect(
      slideCreateTool.handler({ classroom: 'org/x', title: 'New Deck' }, TEACHER_CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      message: expect.stringContaining('content path'),
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps a unique-violation (P2002) to invalid_params', async () => {
    mocks.createSlide.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(
      slideCreateTool.handler({ classroom: 'org/x', title: 'New Deck' }, TEACHER_CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
  });
});

// ─── slide_update ────────────────────────────────────────────────────────────

describe('slide_update', () => {
  it('requires at least one field', async () => {
    await expect(
      slideUpdateTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, TEACHER_CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.updateSlide).not.toHaveBeenCalled();
  });

  it('updates metadata only and audits the touched fields', async () => {
    const payload = parse(
      await slideUpdateTool.handler(
        {
          classroom: 'org/x',
          slide_id: SLIDE_ID,
          title: 'Renamed',
          is_draft: false,
          show_speaker_notes: true,
        },
        TEACHER_CTX
      )
    );

    expect(mocks.updateSlide).toHaveBeenCalledWith(SLIDE_ID, {
      title: 'Renamed',
      is_draft: false,
      show_speaker_notes: true,
    });
    expect(payload).toMatchObject({
      success: true,
      slide: { id: SLIDE_ID, title: 'Renamed', is_draft: false, show_speaker_notes: true },
    });

    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({
      tool: 'slide_update',
      fields: ['title', 'is_draft', 'show_speaker_notes'],
    });
  });
});

// ─── slide_delete ────────────────────────────────────────────────────────────

describe('slide_delete', () => {
  it('wraps the orchestrated delete WITHOUT a cloudinary callback and says videos were skipped', async () => {
    const payload = parse(
      await slideDeleteTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, TEACHER_CTX)
    );

    // No onDeleteVideos, no deleteTheme — MCP has no cloudinary client and
    // never deletes shared themes.
    expect(mocks.deleteSlide).toHaveBeenCalledWith({ slideId: SLIDE_ID });
    expect(payload).toMatchObject({
      success: true,
      deleted: { id: SLIDE_ID, title: 'Intro Week' },
      note: expect.stringContaining('Cloudinary'),
    });
    expect(payload.shared_theme).toBeUndefined();

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: Record<string, unknown>;
    };
    expect(audit.action).toBe('DELETE');
    expect(audit.data).toMatchObject({
      tool: 'slide_delete',
      title: 'Intro Week',
      video_cleanup: 'skipped',
    });
  });

  it('reports a shared theme the deck used (kept, never deleted)', async () => {
    mocks.deleteSlide.mockResolvedValue({
      success: true,
      themeName: 'corp-deck',
      themeDeleted: false,
      otherSlidesUsingTheme: 0,
    });

    const payload = parse(
      await slideDeleteTool.handler({ classroom: 'org/x', slide_id: SLIDE_ID }, TEACHER_CTX)
    );

    expect(payload.shared_theme).toEqual({ name: 'corp-deck', deleted: false });
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(audit.data).toMatchObject({ shared_theme: 'corp-deck' });
  });
});
