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
