/**
 * Unit tests for the shared slides list (student route, re-exported by the
 * assistant prefix).
 *
 * The list must follow the VIEW tier of the shared slide gate
 * (assertSlideAccess): the teaching team may open a draft deck, so the list has
 * to show it. Otherwise staff can reach a deck by URL that they cannot find —
 * the same list/open mismatch that was fixed on the MCP side.
 *
 * Editing is a separate and narrower rule (creator or allow_team_edit) that
 * lives on the deck editor. This list must never grow an edit affordance, so a
 * draft an assistant may view but not edit stays view-only here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ slide: { findMany: (...a: unknown[]) => mocks.findMany(...a) } }),
}));

// The loader is what is under test; the view layer only needs to be importable.
vi.mock('~/components', () => ({ TableActionButtons: () => null }));
vi.mock('antd', () => ({ Table: () => null, Tag: () => null }));
vi.mock('@tabler/icons-react', () => ({ IconEyeOff: () => null }));

const studentRoute = await import('../route.tsx');
const assistantRoute = await import('../../assistant.$class_.slides/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

const PUBLISHED_DECK = { id: 'deck-1', title: 'Recursion', is_draft: false };
const DRAFT_DECK = { id: 'deck-2', title: 'Work in progress', is_draft: true };

const loaderArgs = (prefix: string) =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/slides`),
  }) as unknown as Parameters<typeof studentRoute.loader>[0];

function grant(role: 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT') {
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: `${role.toLowerCase()}-1`,
    classroom: CLASSROOM,
    membership: { id: 'm-1', role },
  });
}

/** The `where` the loader actually handed Prisma. */
function whereClause() {
  return mocks.findMany.mock.calls[0][0].where as Record<string, unknown>;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findMany.mockResolvedValue([PUBLISHED_DECK, DRAFT_DECK]);
});

// ─── Who is admitted at all ──────────────────────────────────────────────────

describe('slides loader — access', () => {
  it('reads at the classroom-member tier, staff and students alike', async () => {
    grant('ASSISTANT');

    await studentRoute.loader(loaderArgs('assistant'));

    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomSlug: CLASS_SLUG,
        allowedRoles: ['STUDENT', 'OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'SLIDES',
        attemptedAction: 'view_slides',
      })
    );
  });
});

// ─── Drafts are listed for staff and only for staff ──────────────────────────

describe('slides loader — drafts follow the view tier', () => {
  it.each([['OWNER'], ['TEACHER'], ['ASSISTANT']] as const)(
    'lists drafts for %s by not filtering them out',
    async role => {
      grant(role);

      const data = await studentRoute.loader(loaderArgs('assistant'));

      // Asserted on the query, not the mocked rows: the filter is the policy.
      expect(whereClause()).toEqual({ classroom_id: 'class-1' });
      expect('is_draft' in whereClause()).toBe(false);
      expect(data.slides).toContainEqual(DRAFT_DECK);
    }
  );

  it('keeps a STUDENT on published decks only', async () => {
    grant('STUDENT');

    await studentRoute.loader(loaderArgs('student'));

    expect(whereClause()).toEqual({ classroom_id: 'class-1', is_draft: false });
  });

  it('treats a viewer with no membership as a student, not as staff', async () => {
    // Defensive: whatever admits a non-member must never widen the listing.
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: null,
      classroom: CLASSROOM,
      membership: null,
    });

    await studentRoute.loader(loaderArgs('student'));

    expect(whereClause()).toEqual({ classroom_id: 'class-1', is_draft: false });
  });
});

// ─── The assistant prefix gets exactly this list, and no edit affordance ─────

describe('assistant slides route', () => {
  it('re-exports the shared loader, so the draft rule cannot drift', () => {
    expect(assistantRoute.loader).toBe(studentRoute.loader);
    expect(assistantRoute.default).toBe(studentRoute.default);
  });

  it('exports no action, so the list can mutate nothing', () => {
    // Deck status/team-edit toggles live on the admin list; the deck editor
    // keeps its own creator/allow_team_edit gate.
    expect('action' in assistantRoute).toBe(false);
    expect('action' in studentRoute).toBe(false);
  });
});
