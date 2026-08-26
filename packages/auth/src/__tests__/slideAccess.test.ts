/**
 * Unit tests for `assertSlideAccess` — the shared slide gate behind every
 * slides-app route and the webapp's deck links.
 *
 * The invariant under test is that VIEW and EDIT are two different rules for a
 * DRAFT deck, and that only the view side is the wide one:
 *
 *   VIEW  — any member of the classroom's teaching team (OWNER, TEACHER,
 *           ASSISTANT) may open a draft deck. Staff prepare course material
 *           together, and the slides app's own list has always shown every
 *           draft to all three roles; refusing to open what it lists was the
 *           mismatch this gate now resolves.
 *   EDIT  — unchanged and narrower: OWNER/TEACHER may edit any deck, an
 *           ASSISTANT only decks they created or decks with allow_team_edit.
 *
 * The pairing matters more than either half: several cases below assert that
 * the SAME assistant on the SAME draft passes 'view' and is refused 'edit'.
 * If a future change collapses the two rules back together, they fail.
 *
 * A pre-fetched `slide` is passed so no Prisma lookup happens; better-auth and
 * the services layer are mocked so the real decision logic runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  auditCreate: vi.fn(),
  getGitHubTokenForUser: vi.fn(),
}));

vi.mock('better-auth', () => ({
  betterAuth: () => ({ api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } }),
}));
vi.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: () => ({}) }));
vi.mock('better-auth/plugins', () => ({ admin: () => ({}), mcp: () => ({}) }));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    githubUserToken: {
      getGitHubTokenForUser: (...a: unknown[]) => mocks.getGitHubTokenForUser(...a),
    },
  },
}));

const { assertSlideAccess } = await import('../server.ts');

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

const SLIDE_ID = 'slide-1';
const CREATOR_ID = 'creator-1';

/** A private draft nobody but its creator may edit. */
const DRAFT = {
  id: SLIDE_ID,
  classroom_id: 'class-1',
  created_by: CREATOR_ID,
  allow_team_edit: false,
  is_draft: true,
  is_public: false,
  multiplex_id: null,
  show_speaker_notes: false,
};

const request = () => new Request('http://localhost/slides/slide-1');

/** Sign the caller in as `userId` holding `role` in the deck's classroom. */
function signedInAs(role: Role | null, userId: string) {
  mocks.getSession.mockResolvedValue({ user: { id: userId, name: userId } });
  mocks.findByClassroomAndUser.mockResolvedValue(role ? { id: 'm-1', role } : null);
}

/**
 * Sign the caller in holding SEVERAL roles at once.
 *
 * ClassroomMembership is unique on (classroom_id, user_id, role), so this is a
 * routine shape: promoting a student to assistant adds a row rather than
 * replacing one. The gate probes one role at a time, so the mock answers per
 * requested role — which is exactly what makes the resolution deterministic.
 */
function signedInHolding(roles: Role[], userId: string) {
  mocks.getSession.mockResolvedValue({ user: { id: userId, name: userId } });
  mocks.findByClassroomAndUser.mockImplementation(
    (_classroomId: unknown, _userId: unknown, requested: unknown) => {
      const wanted = Array.isArray(requested) ? (requested as Role[]) : null;
      const match = wanted ? wanted.find(role => roles.includes(role)) : roles[0];
      return Promise.resolve(match ? { id: `m-${match}`, role: match } : null);
    }
  );
}

const accessTo = (slide: typeof DRAFT, accessType: 'view' | 'edit' | 'present' | 'speakerNotes') =>
  assertSlideAccess({ request: request(), slideId: SLIDE_ID, slide, accessType });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getGitHubTokenForUser.mockResolvedValue(null);
  mocks.auditCreate.mockResolvedValue(undefined);
});

// ─── VIEW: the whole teaching team ───────────────────────────────────────────

describe('draft deck — who may VIEW', () => {
  it.each([['OWNER'], ['TEACHER'], ['ASSISTANT']] as const)(
    'admits %s, including one who did not create the deck',
    async role => {
      signedInAs(role, 'staff-1');

      const result = await accessTo(DRAFT, 'view');

      expect(result.canView).toBe(true);
      expect(result.membership).toMatchObject({ role });
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it('refuses a STUDENT of the same classroom', async () => {
    signedInAs('STUDENT', 'student-1');

    await expect(accessTo(DRAFT, 'view')).rejects.toMatchObject({ status: 403 });
    // The refusal is recorded, as for any denied member.
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ACCESS_DENIED', resource_type: 'SLIDE' })
    );
  });

  it('refuses someone with no membership in the classroom', async () => {
    signedInAs(null, 'outsider-1');

    await expect(accessTo(DRAFT, 'view')).rejects.toMatchObject({ status: 403 });
    // Nothing to audit for a non-member — there is no membership to attribute.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses an anonymous request', async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(accessTo(DRAFT, 'view')).rejects.toMatchObject({ status: 403 });
  });
});

// ─── EDIT: unchanged, and narrower ───────────────────────────────────────────

describe('draft deck — who may EDIT', () => {
  it('still refuses an ASSISTANT who is neither the creator nor covered by allow_team_edit', async () => {
    signedInAs('ASSISTANT', 'ta-1');

    await expect(accessTo(DRAFT, 'edit')).rejects.toMatchObject({ status: 403 });
  });

  it('allows the ASSISTANT who created the deck', async () => {
    signedInAs('ASSISTANT', CREATOR_ID);

    const result = await accessTo(DRAFT, 'edit');

    expect(result.canEdit).toBe(true);
    expect(result.accessGrantedVia).toBe('ownership');
  });

  it('allows any ASSISTANT once allow_team_edit is set', async () => {
    signedInAs('ASSISTANT', 'ta-1');

    const result = await accessTo({ ...DRAFT, allow_team_edit: true }, 'edit');

    expect(result.canEdit).toBe(true);
    expect(result.accessGrantedVia).toBe('team_edit');
  });

  it.each([['OWNER'], ['TEACHER']] as const)('allows %s on any deck', async role => {
    signedInAs(role, 'staff-1');

    const result = await accessTo(DRAFT, 'edit');

    expect(result.canEdit).toBe(true);
    expect(result.accessGrantedVia).toBe('role');
  });

  it('refuses a STUDENT', async () => {
    signedInAs('STUDENT', 'student-1');

    await expect(accessTo(DRAFT, 'edit')).rejects.toMatchObject({ status: 403 });
  });
});

// ─── The split itself ────────────────────────────────────────────────────────

describe('view and edit are separate rules', () => {
  it('one assistant, one draft: may view it, may not edit it', async () => {
    signedInAs('ASSISTANT', 'ta-1');
    const viewed = await accessTo(DRAFT, 'view');

    expect(viewed.canView).toBe(true);
    expect(viewed.canEdit).toBe(false);

    signedInAs('ASSISTANT', 'ta-1');
    await expect(accessTo(DRAFT, 'edit')).rejects.toMatchObject({ status: 403 });
  });

  it('reports the view as granted by role, not by ownership or team_edit', async () => {
    signedInAs('ASSISTANT', 'ta-1');

    expect((await accessTo(DRAFT, 'view')).accessGrantedVia).toBe('role');
  });

  it('leaves published decks alone: a student still views a published private deck', async () => {
    signedInAs('STUDENT', 'student-1');

    const result = await accessTo({ ...DRAFT, is_draft: false }, 'view');

    expect(result.canView).toBe(true);
    expect(result.accessGrantedVia).toBe('membership');
    expect(result.canEdit).toBe(false);
  });
});

// ─── PRESENT and SPEAKER NOTES on a draft ────────────────────────────────────

/**
 * The two access types that were previously untested on a draft, which is why
 * widening the draft view tier moved them without anyone noticing.
 *
 * PRESENT stays pinned to edit rights: reading a colleague's unfinished deck is
 * expected, driving it in front of a class is not.
 *
 * SPEAKER NOTES follow staff-ness, not editability — `canViewSpeakerNotes` is
 * `isStaff || (show_speaker_notes && canView)`. Since staff may now view a
 * draft, an assistant gets the notes on a draft they cannot edit. That is the
 * ACCEPTED policy (staff already get notes unconditionally on any deck they can
 * view); these tests exist so a future change has to say so out loud.
 */
describe('draft deck — who may PRESENT', () => {
  it.each([['OWNER'], ['TEACHER']] as const)('allows %s, who may also edit it', async role => {
    signedInAs(role, 'staff-1');

    const result = await accessTo(DRAFT, 'present');

    expect(result.canPresent).toBe(true);
  });

  it('allows the ASSISTANT who created the deck', async () => {
    signedInAs('ASSISTANT', CREATOR_ID);

    expect((await accessTo(DRAFT, 'present')).canPresent).toBe(true);
  });

  it('allows any ASSISTANT once allow_team_edit is set', async () => {
    signedInAs('ASSISTANT', 'ta-1');

    expect((await accessTo({ ...DRAFT, allow_team_edit: true }, 'present')).canPresent).toBe(true);
  });

  it('still refuses an ASSISTANT who may VIEW the draft but not edit it', async () => {
    // The pairing is the point: the same call would pass `view`.
    signedInAs('ASSISTANT', 'ta-1');
    expect((await accessTo(DRAFT, 'view')).canView).toBe(true);

    signedInAs('ASSISTANT', 'ta-1');
    await expect(accessTo(DRAFT, 'present')).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a STUDENT', async () => {
    signedInAs('STUDENT', 'student-1');

    await expect(accessTo(DRAFT, 'present')).rejects.toMatchObject({ status: 403 });
  });
});

describe('draft deck — who may read SPEAKER NOTES', () => {
  it.each([['OWNER'], ['TEACHER'], ['ASSISTANT']] as const)(
    'allows %s even with show_speaker_notes off',
    async role => {
      signedInAs(role, 'staff-1');

      const result = await accessTo(DRAFT, 'speakerNotes');

      expect(result.canViewSpeakerNotes).toBe(true);
    }
  );

  it('allows an ASSISTANT on a draft they may view but NOT edit — accepted policy', async () => {
    signedInAs('ASSISTANT', 'ta-1');

    const result = await accessTo(DRAFT, 'speakerNotes');

    expect(result.canViewSpeakerNotes).toBe(true);
    expect(result.canEdit).toBe(false);
  });

  it('refuses a STUDENT, because notes ride on being able to view the deck', async () => {
    // Even with the flag on: a student cannot view a draft, so there is nothing
    // for show_speaker_notes to extend.
    signedInAs('STUDENT', 'student-1');

    await expect(
      accessTo({ ...DRAFT, show_speaker_notes: true }, 'speakerNotes')
    ).rejects.toMatchObject({ status: 403 });
  });

  it('extends to a STUDENT on a PUBLISHED deck when show_speaker_notes is on', async () => {
    // The flag governs non-staff viewers; this is the case it exists for.
    signedInAs('STUDENT', 'student-1');

    const result = await accessTo(
      { ...DRAFT, is_draft: false, show_speaker_notes: true },
      'speakerNotes'
    );

    expect(result.canViewSpeakerNotes).toBe(true);
  });
});

// ─── Users holding more than one role in the same classroom ──────────────────

/**
 * ClassroomMembership is unique on (classroom_id, user_id, role), so holding
 * several roles in one classroom is normal — adding an assistant does not
 * remove their existing student row. The gate resolves the caller's HIGHEST
 * role, so the staff half of a dual-role membership decides the outcome.
 */
describe('a user holding several roles in the classroom', () => {
  it('treats OWNER+STUDENT as an OWNER on a draft', async () => {
    signedInHolding(['OWNER', 'STUDENT'], 'prof-1');

    const result = await accessTo(DRAFT, 'view');

    expect(result.membership).toMatchObject({ role: 'OWNER' });
    expect(result.canView).toBe(true);
    expect(result.canEdit).toBe(true);
  });

  it('treats ASSISTANT+STUDENT as an ASSISTANT on a draft', async () => {
    signedInHolding(['ASSISTANT', 'STUDENT'], 'ta-1');

    const result = await accessTo(DRAFT, 'view');

    expect(result.membership).toMatchObject({ role: 'ASSISTANT' });
    expect(result.canView).toBe(true);
    // Still not an editor — the wider VIEW tier is all the assistant half buys.
    expect(result.canEdit).toBe(false);
  });

  it('does not let the STUDENT half deny a draft the staff half may read', async () => {
    // The regression this pins: an unordered lookup could resolve the STUDENT
    // row and refuse a deck the same person may open as staff.
    signedInHolding(['ASSISTANT', 'STUDENT'], 'ta-1');
    await expect(accessTo(DRAFT, 'view')).resolves.toMatchObject({ canView: true });

    signedInHolding(['ASSISTANT', 'STUDENT'], 'ta-1');
    await expect(accessTo(DRAFT, 'speakerNotes')).resolves.toMatchObject({
      canViewSpeakerNotes: true,
    });
  });

  it('resolves the same way whichever order the roles come back in', async () => {
    signedInHolding(['STUDENT', 'ASSISTANT'], 'ta-1');

    expect((await accessTo(DRAFT, 'view')).membership).toMatchObject({ role: 'ASSISTANT' });
  });
});
