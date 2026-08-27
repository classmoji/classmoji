/**
 * Unit tests for the admin slide-settings action.
 *
 * The action authorizes against the classroom in the URL, but the deck it acts
 * on arrives as `slideId` in the form body. Those two facts have to be tied
 * together in the query itself: every write is bound to
 * `{ id, classroom_id }` and only counts when it matched exactly one row. A
 * deck id belonging to some other classroom therefore changes nothing and comes
 * back as the route's ordinary not-found result.
 *
 * The loader is already classroom-scoped (`where: { classroom_id }`); it is
 * pinned here too so the pair cannot drift.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  getRecentViewersForPaths: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    slide: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      update: (...a: unknown[]) => mocks.update(...a),
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
    },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    resourceView: {
      getRecentViewersForPaths: (...a: unknown[]) => mocks.getRecentViewersForPaths(...a),
    },
  },
}));

// The loader/action are what is under test; the view layer only needs to import.
vi.mock('~/components', () => ({ TableActionButtons: () => null, RecentViewers: () => null }));
vi.mock('antd', () => ({
  Table: () => null,
  Button: () => null,
  Tag: () => null,
  Select: () => null,
  Switch: () => null,
  Tooltip: () => null,
}));
vi.mock('@tabler/icons-react', () => ({
  IconPlus: () => null,
  IconPresentation: () => null,
  IconEyeOff: () => null,
  IconLock: () => null,
  IconWorld: () => null,
  IconEdit: () => null,
  IconNotes: () => null,
}));
vi.mock('react-router', () => ({ useFetcher: () => ({ submit: vi.fn() }) }));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const OWN_SLIDE = 'slide-in-this-classroom';
const FOREIGN_SLIDE = 'slide-in-another-classroom';

const actionArgs = (body: Record<string, string>) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.append(key, value);
  return {
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/slides`, {
      method: 'POST',
      body: formData,
    }),
  } as unknown as Parameters<typeof route.action>[0];
};

/** The `where` of the single write the action performed. */
const writeWhere = () => mocks.updateMany.mock.calls[0][0].where as Record<string, unknown>;
/** The `data` of the single write the action performed. */
const writeData = () => mocks.updateMany.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.findMany.mockResolvedValue([]);
  mocks.getRecentViewersForPaths.mockResolvedValue(new Map());
  // One row matched = the deck really is in this classroom.
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

// ─── A deck of this classroom updates normally ───────────────────────────────

describe('slides action — updating a deck of this classroom', () => {
  it('writes the status pair bound to the classroom', async () => {
    const result = await route.action(
      actionArgs({ slideId: OWN_SLIDE, field: 'status', value: 'public' })
    );

    expect(result).toEqual({ success: true });
    expect(writeWhere()).toEqual({ id: OWN_SLIDE, classroom_id: 'class-1' });
    expect(writeData()).toEqual({ is_draft: false, is_public: true });
  });

  it.each([
    ['draft', { is_draft: true, is_public: false }],
    ['private', { is_draft: false, is_public: false }],
    ['public', { is_draft: false, is_public: true }],
  ] as const)('maps status "%s" to its flag pair', async (value, expected) => {
    await route.action(actionArgs({ slideId: OWN_SLIDE, field: 'status', value }));

    expect(writeData()).toEqual(expected);
  });

  it.each([['allow_team_edit'], ['show_speaker_notes']] as const)(
    'writes the %s toggle bound to the classroom',
    async field => {
      const result = await route.action(actionArgs({ slideId: OWN_SLIDE, field, value: 'true' }));

      expect(result).toEqual({ success: true });
      expect(writeWhere()).toEqual({ id: OWN_SLIDE, classroom_id: 'class-1' });
      expect(writeData()).toEqual({ [field]: true });
    }
  );

  it('reads "false" as false rather than as a truthy string', async () => {
    await route.action(
      actionArgs({ slideId: OWN_SLIDE, field: 'show_speaker_notes', value: 'false' })
    );

    expect(writeData()).toEqual({ show_speaker_notes: false });
  });
});

// ─── A deck of ANOTHER classroom changes nothing ─────────────────────────────

describe('slides action — a deck id from another classroom', () => {
  beforeEach(() => {
    // The classroom_id half of the where matches nothing.
    mocks.updateMany.mockResolvedValue({ count: 0 });
  });

  it.each([
    ['status', 'public'],
    ['allow_team_edit', 'true'],
    ['show_speaker_notes', 'true'],
  ] as const)('changes nothing and reports not-found for field "%s"', async (field, value) => {
    const result = await route.action(actionArgs({ slideId: FOREIGN_SLIDE, field, value }));

    expect(result).toEqual({ error: 'Slide not found' });
    // The classroom the request was authorized for is part of the query, so the
    // write could not have matched a deck outside it.
    expect(writeWhere()).toEqual({ id: FOREIGN_SLIDE, classroom_id: 'class-1' });
  });

  it('never reaches an unscoped single-row update', async () => {
    await route.action(actionArgs({ slideId: FOREIGN_SLIDE, field: 'status', value: 'draft' }));

    expect(mocks.update).not.toHaveBeenCalled();
  });
});

// ─── Everything else the action refuses ──────────────────────────────────────

describe('slides action — inputs it will not act on', () => {
  it('rejects an unknown field without writing', async () => {
    const result = await route.action(
      actionArgs({ slideId: OWN_SLIDE, field: 'created_by', value: 'someone-else' })
    );

    expect(result).toEqual({ error: 'Invalid field' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a missing slideId without writing', async () => {
    const result = await route.action(actionArgs({ field: 'status', value: 'public' }));

    expect(result).toEqual({ error: 'Slide not found' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('authorizes as OWNER/TEACHER and checks the mutation gate first', async () => {
    await route.action(actionArgs({ slideId: OWN_SLIDE, field: 'status', value: 'public' }));

    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomSlug: CLASS_SLUG,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'SLIDES',
        attemptedAction: 'update_slide_visibility',
      })
    );
    expect(mocks.assertClassroomMutationAllowed).toHaveBeenCalledWith({
      status: 'ACTIVE',
      role: 'OWNER',
    });
  });

  it('does not write when the authorization gate throws', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(
      route.action(actionArgs({ slideId: OWN_SLIDE, field: 'status', value: 'public' }))
    ).rejects.toBeInstanceOf(Response);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

// ─── Every successful toggle leaves an audit row ─────────────────────────────

/**
 * The MCP slide tools have always audited their writes; this surface did not.
 * The rows are shaped to match theirs — resource_type 'SLIDES', the deck id,
 * action UPDATE — so both surfaces can be queried together.
 *
 * `tool` is not decoration. The audit service dedups within a 5-second window
 * on (user, classroom, role, resource_type, resource_id, action) plus
 * `data.tool`; without a distinct tool per toggle, flipping two switches on one
 * deck in quick succession would record only the first.
 */
describe('slides action — audit rows', () => {
  it('audits a status change with the flags it wrote', async () => {
    await route.action(actionArgs({ slideId: OWN_SLIDE, field: 'status', value: 'public' }));

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'UPDATE',
      resourceType: 'SLIDES',
      resourceId: OWN_SLIDE,
      metadata: {
        tool: 'web:slides.status',
        field: 'status',
        value: 'public',
        is_draft: false,
        is_public: true,
      },
    });
  });

  it.each([['allow_team_edit'], ['show_speaker_notes']] as const)(
    'audits the %s toggle under its own tool name',
    async field => {
      await route.action(actionArgs({ slideId: OWN_SLIDE, field, value: 'true' }));

      expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          action: 'UPDATE',
          resourceType: 'SLIDES',
          resourceId: OWN_SLIDE,
          metadata: { tool: `web:slides.${field}`, field, value: true },
        })
      );
    }
  );

  it('gives the two toggles distinct tool names so neither is deduped away', async () => {
    await route.action(actionArgs({ slideId: OWN_SLIDE, field: 'allow_team_edit', value: 'true' }));
    await route.action(
      actionArgs({ slideId: OWN_SLIDE, field: 'show_speaker_notes', value: 'true' })
    );

    const tools = mocks.addClassroomAuditLog.mock.calls.map(
      ([entry]) => (entry as { metadata: { tool: string } }).metadata.tool
    );
    expect(new Set(tools).size).toBe(2);
  });

  it('writes no row for a deck that is not in this classroom', async () => {
    // count !== 1 means nothing was updated, so there is nothing to record.
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await route.action(actionArgs({ slideId: FOREIGN_SLIDE, field: 'status', value: 'public' }));

    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

// ─── The loader is scoped the same way ───────────────────────────────────────

describe('slides loader', () => {
  it('lists only decks of the authorized classroom', async () => {
    await route.loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/slides`),
    } as unknown as Parameters<typeof route.loader>[0]);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classroom_id: 'class-1' } })
    );
  });
});
