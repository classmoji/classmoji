/**
 * The tag rule on the webapp's team routes: every team has at least one tag.
 *
 * Pinned here:
 *   - new team (admin.$class.teams.new, ?/createTeam): the chosen tags reach
 *     teamAdmin.createTeam with the classroom the OWNER gate authorized, and the
 *     service's `tag_required` refusal comes back as its own fixed sentence, not
 *     the generic "Could not create this team." — as does a tag write that fails
 *     because the tag was deleted meanwhile (P2003);
 *   - new team, ?/createTag: the tag is upserted in the authorized classroom
 *     (never one from the body) under the trimmed name, an empty name is refused
 *     without a write, and a failed write is reported without its cause;
 *   - edit team (admin.$class.teams.$slug.edit, ?/removeTeamTag): the service's
 *     refusal to remove a team's last tag comes back as its own fixed sentence,
 *     and other codes keep their messages and the generic default.
 *
 * The rule itself (no provider call without a valid tag, the last-tag count
 * under a row lock) is pinned in packages/services
 * (classmoji/__tests__/team.service.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { TeamServiceError } = vi.hoisted(() => ({
  TeamServiceError: class TeamServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  createTeam: vi.fn(),
  removeTeamTag: vi.fn(),
  tagUpsert: vi.fn(),
  tagsByClassroom: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    teamAdmin: {
      createTeam: (...a: unknown[]) => mocks.createTeam(...a),
      removeTeamTag: (...a: unknown[]) => mocks.removeTeamTag(...a),
    },
    organizationTag: {
      upsert: (...a: unknown[]) => mocks.tagUpsert(...a),
      findByClassroomId: (...a: unknown[]) => mocks.tagsByClassroom(...a),
    },
  },
  TeamServiceError,
  describeTeamFailureReason: (reason: string) => reason,
}));

// The actions are what is under test; the view layer only needs to import.
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({ fetcher: null, notify: vi.fn() }),
  useDisclosure: () => ({ show: vi.fn(), close: vi.fn(), visible: true }),
}));

const newTeam = await import('../admin.$class.teams.new/route.tsx');
const editTeam = await import('../admin.$class.teams.$slug.edit/action');

const CLASS_SLUG = 'cs-101';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const TEAM_SLUG = 'team-red';

type Payload = { error?: string; success?: string; action?: string; tag?: unknown };

const postNewTeam = (intent: 'createTeam' | 'createTag', body: Record<string, unknown>) =>
  newTeam.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/teams/new?/${intent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof newTeam.action>[0]) as Promise<Payload>;

const postEditTeam = (intent: string, body: Record<string, unknown>) =>
  editTeam.action({
    params: { class: CLASS_SLUG, slug: TEAM_SLUG },
    request: new Request(
      `http://localhost/admin/${CLASS_SLUG}/teams/${TEAM_SLUG}/edit?/${intent}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    ),
  } as unknown as Parameters<typeof editTeam.action>[0]) as Promise<Payload>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
});

describe('new team — createTeam', () => {
  it('passes the chosen tags with the authorized classroom', async () => {
    mocks.createTeam.mockResolvedValue({
      team: { id: 't-1', name: 'Red', slug: 'red', is_visible: true },
      tagsAdded: ['tag-1'],
      tagsFailed: [],
    });

    const result = await postNewTeam('createTeam', {
      name: 'Red',
      tags: ['tag-1'],
      visibility: 'closed',
      classroomId: 'someone-elses',
    });

    expect(mocks.createTeam).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      name: 'Red',
      isVisible: true,
      tagIds: ['tag-1'],
    });
    expect(result).toEqual({ success: 'Team created successfully', action: 'save-team' });
  });

  it('reports tag_required with its own sentence', async () => {
    mocks.createTeam.mockRejectedValue(
      new TeamServiceError('tag_required', '[team] a team needs at least one tag')
    );

    const result = await postNewTeam('createTeam', { name: 'Red', visibility: 'closed' });

    // No tags in the body still goes to the service, which owns the rule.
    expect(mocks.createTeam).toHaveBeenCalledWith(expect.objectContaining({ tagIds: [] }));
    expect(result).toEqual({
      error: 'A team needs at least one tag from this classroom.',
      action: 'save-team',
    });
  });

  it('reports a tag deleted mid-create (a foreign-key failure) as tag_required', async () => {
    mocks.createTeam.mockRejectedValue(
      Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' })
    );

    const result = await postNewTeam('createTeam', {
      name: 'Red',
      tags: ['tag-gone'],
      visibility: 'closed',
    });

    expect(result).toEqual({
      error: 'A team needs at least one tag from this classroom.',
      action: 'save-team',
    });
  });

  it('still throws other database failures', async () => {
    mocks.createTeam.mockRejectedValue(
      Object.assign(new Error('Connection lost'), { code: 'P1001' })
    );

    await expect(
      postNewTeam('createTeam', { name: 'Red', tags: ['tag-1'], visibility: 'closed' })
    ).rejects.toMatchObject({ code: 'P1001' });
  });

  it('keeps the generic sentence for codes it does not name', async () => {
    mocks.createTeam.mockRejectedValue(new TeamServiceError('tag_not_found', 'x'));

    const result = await postNewTeam('createTeam', { name: 'Red', tags: ['tag-1'] });

    expect(result).toEqual({ error: 'Could not create this team.', action: 'save-team' });
  });
});

describe('new team — createTag', () => {
  it('upserts the trimmed name in the authorized classroom', async () => {
    mocks.tagUpsert.mockResolvedValue({ id: 'tag-9', name: 'Projects', classroom_id: 'class-1' });

    const result = await postNewTeam('createTag', {
      name: '  Projects  ',
      classroomId: 'someone-elses',
    });

    expect(mocks.tagUpsert).toHaveBeenCalledExactlyOnceWith('class-1', 'Projects');
    expect(result).toEqual({ tag: { id: 'tag-9', name: 'Projects' } });
  });

  it.each([[''], ['   '], [undefined], [42]])('refuses the name %j without a write', async name => {
    const result = await postNewTeam('createTag', { name });

    expect(mocks.tagUpsert).not.toHaveBeenCalled();
    expect(result).toEqual({ error: 'A tag name is required.' });
  });

  it('reports a failed write without its cause', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.tagUpsert.mockRejectedValue(new Error('P1001: database unreachable'));

    const result = await postNewTeam('createTag', { name: 'Projects' });

    expect(result).toEqual({ error: 'Could not create the tag.' });
    quiet.mockRestore();
  });

  it('runs behind the same OWNER and mutation gates as createTeam', async () => {
    mocks.tagUpsert.mockResolvedValue({ id: 'tag-9', name: 'Projects' });

    await postNewTeam('createTag', { name: 'Projects' });

    expect(mocks.requireClassroomAdmin).toHaveBeenCalledWith(
      expect.any(Request),
      CLASS_SLUG,
      expect.objectContaining({ resourceType: 'TEAMS' })
    );
    expect(mocks.assertClassroomMutationAllowed).toHaveBeenCalledWith({
      status: 'ACTIVE',
      role: 'OWNER',
    });
  });
});

describe('edit team — removeTeamTag', () => {
  it("reports the last tag's refusal with its own sentence", async () => {
    mocks.removeTeamTag.mockRejectedValue(
      new TeamServiceError('tag_required', "[team] a team's last tag cannot be removed")
    );

    const result = await postEditTeam('removeTeamTag', { id: 'tt-1' });

    expect(mocks.removeTeamTag).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      teamTagId: 'tt-1',
    });
    expect(result).toEqual({
      error: `A team needs at least one tag, so the last tag on @${TEAM_SLUG} can't be removed.`,
      action: 'remove-team-tag',
    });
  });

  it('removes a tag that is not the last one', async () => {
    mocks.removeTeamTag.mockResolvedValue({ teamTagId: 'tt-1', teamId: 't-1', tagId: 'tag-1' });

    const result = await postEditTeam('removeTeamTag', { id: 'tt-1' });

    expect(result).toEqual({ success: 'Tag removed successfully', action: 'remove-team-tag' });
  });

  it('keeps the other messages and the generic default', async () => {
    mocks.removeTeamTag.mockRejectedValueOnce(new TeamServiceError('tag_not_found', 'x'));
    expect(await postEditTeam('removeTeamTag', { id: 'tt-x' })).toEqual({
      error: 'That tag is not on this team.',
      action: 'remove-team-tag',
    });

    mocks.removeTeamTag.mockRejectedValueOnce(new TeamServiceError('some_new_code', 'x'));
    expect(await postEditTeam('removeTeamTag', { id: 'tt-x' })).toEqual({
      error: 'Could not complete this action.',
      action: 'remove-team-tag',
    });
  });
});
