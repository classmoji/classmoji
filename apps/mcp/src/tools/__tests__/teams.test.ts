/**
 * Unit tests for the team tools.
 *
 * Security focus: the classroomId handed to every service call comes from the
 * ToolContext, never from args; an unknown or foreign team/tag is the uniform
 * scopedNotFound with no further service call; team_members_add refuses logins
 * that are not classroom members BEFORE anything reaches the team service; no
 * mutation is left un-audited, and every audit row names the team; and no
 * response echoes a raw service row (team.findByClassroomId carries full
 * member User records).
 *
 * `@classmoji/services` is mocked (factory idiom) INCLUDING TeamServiceError,
 * so the handlers' `instanceof` mapping runs against the same class the tests
 * throw — no real GitHub calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  createTeam: vi.fn(),
  deleteTeam: vi.fn(),
  renameTeam: vi.fn(),
  addTeamMembers: vi.fn(),
  removeTeamMember: vi.fn(),
  addTeamTags: vi.fn(),
  removeTeamTag: vi.fn(),
  findTeamsByClassroomId: vi.fn(),
  findMembershipsByClassroomId: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => {
  // Same shape as the real service error; the tools branch on `instanceof`, so
  // the class the handler imports must be the class the test constructs.
  class TeamServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'TeamServiceError';
      this.code = code;
    }
  }
  return {
    TeamServiceError,
    // The reason→phrase mapper is pure; the tools only need it to produce a
    // non-empty phrase per code, so the fake keeps the test independent of the
    // exact wording.
    describeTeamFailureReason: (reason: string) => `reason:${reason}`,
    ClassmojiService: {
      teamAdmin: {
        createTeam: (...a: unknown[]) => mocks.createTeam(...a),
        deleteTeam: (...a: unknown[]) => mocks.deleteTeam(...a),
        renameTeam: (...a: unknown[]) => mocks.renameTeam(...a),
        addTeamMembers: (...a: unknown[]) => mocks.addTeamMembers(...a),
        removeTeamMember: (...a: unknown[]) => mocks.removeTeamMember(...a),
        addTeamTags: (...a: unknown[]) => mocks.addTeamTags(...a),
        removeTeamTag: (...a: unknown[]) => mocks.removeTeamTag(...a),
      },
      team: { findByClassroomId: (...a: unknown[]) => mocks.findTeamsByClassroomId(...a) },
      classroomMembership: {
        findByClassroomId: (...a: unknown[]) => mocks.findMembershipsByClassroomId(...a),
      },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
  };
});

const { TeamServiceError } = await import('@classmoji/services');
const {
  teamCreateTool,
  teamDeleteTool,
  teamRenameTool,
  teamMembersAddTool,
  teamMemberRemoveTool,
  teamTagAddTool,
  teamTagRemoveTool,
} = await import('../teams.ts');

const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** The audit row the handler wrote (first call). */
function auditRow() {
  return mocks.auditCreate.mock.calls[0][0] as {
    action: string;
    classroom_id: string;
    resource_type: string;
    resource_id?: string | null;
    data: Record<string, unknown>;
  };
}

/**
 * A team row shaped like team.findByClassroomId returns it — memberships carry
 * FULL User records (contact PII), which is exactly what must never be echoed.
 */
const TEAM_ROW = {
  id: 'team-1',
  name: 'Team Rocket',
  slug: 'team-rocket',
  is_visible: false,
  created_at: new Date('2026-01-01T00:00:00Z'),
  memberships: [
    { id: 'tm-1', user: { id: 'u-1', login: 'ada', email: 'ada@x.edu', school_id: 'S1' } },
  ],
  tags: [
    { id: 'tt-1', tag_id: 'tag-1', tag: { id: 'tag-1', name: 'frontend' } },
    { id: 'tt-2', tag_id: 'tag-2', tag: { id: 'tag-2', name: 'week-3' } },
  ],
};

/** No response may carry member PII or raw relation rows from a service row. */
function expectNoServiceRowLeak(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain('memberships');
  expect(text).not.toContain('ada@x.edu');
  expect(text).not.toContain('school_id');
  expect(text).not.toContain('created_at');
}

/** Every teamAdmin mutation mock, for "the service was never reached" asserts. */
const teamAdminMocks = () => [
  mocks.createTeam,
  mocks.deleteTeam,
  mocks.renameTeam,
  mocks.addTeamMembers,
  mocks.removeTeamMember,
  mocks.addTeamTags,
  mocks.removeTeamTag,
];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.findTeamsByClassroomId.mockResolvedValue([TEAM_ROW]);
  mocks.findMembershipsByClassroomId.mockResolvedValue([
    { role: 'STUDENT', user: { id: 'u-1', login: 'ada', email: 'ada@x.edu' } },
    { role: 'ASSISTANT', user: { id: 'u-2', login: 'Grace' } },
    { role: 'STUDENT', user: null },
  ]);
});

describe('team_create', () => {
  const ARGS = { classroom: 'org/w26', name: 'Team Rocket', tag_ids: ['tag-1'] };

  it('creates via the service using ctx classroomId and audits the CREATE', async () => {
    mocks.createTeam.mockResolvedValue({
      team: { id: 'team-1', name: 'Team Rocket', slug: 'team-rocket', isVisible: false },
      tagsAdded: ['tag-1'],
      tagsFailed: [{ tagId: 'tag-9', error: 'invalid' }],
    });

    const payload = parse(await teamCreateTool.handler(ARGS, CTX));
    expect(payload).toEqual({
      success: true,
      team: { id: 'team-1', name: 'Team Rocket', slug: 'team-rocket', is_visible: false },
      tags_added: ['tag-1'],
      // The service's closed reason vocabulary, plus its phrase.
      tags_failed: [{ tag_id: 'tag-9', error: 'invalid', error_description: expect.any(String) }],
    });

    // classroomId comes from ctx, never from args; is_visible defaults to false.
    expect(mocks.createTeam).toHaveBeenCalledWith({
      classroomId: 'class-1',
      name: 'Team Rocket',
      isVisible: false,
      tagIds: ['tag-1'],
    });

    const audit = auditRow();
    expect(audit.action).toBe('CREATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('TEAMS');
    // resource_id names the team; it is part of the audit dedup key, so two
    // creates inside the dedup window stay two rows.
    expect(audit.resource_id).toBe('team-1');
    expect(audit.data).toMatchObject({ tool: 'team_create', team_id: 'team-1' });
  });

  it('passes is_visible through when set', async () => {
    mocks.createTeam.mockResolvedValue({
      team: { id: 'team-1', name: 'Team Rocket', slug: 'team-rocket', isVisible: true },
      tagsAdded: [],
      tagsFailed: [],
    });

    const payload = parse(
      await teamCreateTool.handler({ ...ARGS, is_visible: true, tag_ids: undefined }, CTX)
    );
    expect(payload.team.is_visible).toBe(true);
    expect(mocks.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({ isVisible: true, tagIds: [] })
    );
  });

  it('maps reserved_name to invalid_params and audits nothing', async () => {
    mocks.createTeam.mockRejectedValue(
      new TeamServiceError('reserved_name', '[team] "w26-students" is reserved for classroom teams')
    );

    await expect(teamCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: '"w26-students" is reserved for classroom teams',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps name_collision to invalid_params', async () => {
    mocks.createTeam.mockRejectedValue(
      new TeamServiceError('name_collision', '[team] a team named "Team Rocket" already exists')
    );

    await expect(teamCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'a team named "Team Rocket" already exists',
    });
  });

  it('maps no_org_configured to invalid_params without echoing the internal id', async () => {
    mocks.createTeam.mockRejectedValue(
      new TeamServiceError('no_org_configured', '[team] classroom class-1 has no git organization')
    );

    await expect(teamCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'This classroom has no linked GitHub organization — teams cannot be managed',
    });
  });

  it('carries a tighter rate-limit bucket than the default (each call creates a GitHub team)', () => {
    expect(teamCreateTool.rateLimit).toEqual({ capacity: 5, refillPerSecond: 0.05 });
  });

  it('lets an unexpected service failure through for the generic wrapper', async () => {
    mocks.createTeam.mockRejectedValue(new Error('boom'));
    await expect(teamCreateTool.handler(ARGS, CTX)).rejects.toThrow('boom');
  });
});

describe('team_delete', () => {
  const ARGS = { classroom: 'org/w26', team: 'team-rocket', confirm: true as const };

  it('deletes via the service and audits the DELETE', async () => {
    mocks.deleteTeam.mockResolvedValue({
      id: 'team-1',
      name: 'Team Rocket',
      slug: 'team-rocket',
      removedFromProvider: true,
      reposDeleted: 0,
      deletedRepoNames: [],
    });

    const payload = parse(await teamDeleteTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      id: 'team-1',
      slug: 'team-rocket',
      removed_from_provider: true,
      repos_deleted: 0,
    });

    expect(mocks.deleteTeam).toHaveBeenCalledWith({
      classroomId: 'class-1',
      slugOrId: 'team-rocket',
    });

    const audit = auditRow();
    expect(audit.action).toBe('DELETE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_id).toBe('team-1');
    expect(audit.data).toMatchObject({ tool: 'team_delete', team_id: 'team-1' });
  });

  it('reports removed_from_provider:false when the GitHub team was already gone', async () => {
    mocks.deleteTeam.mockResolvedValue({
      id: 'team-1',
      name: 'Team Rocket',
      slug: 'team-rocket',
      removedFromProvider: false,
      reposDeleted: 0,
      deletedRepoNames: [],
    });

    const payload = parse(await teamDeleteTool.handler(ARGS, CTX));
    expect(payload.removed_from_provider).toBe(false);
  });

  it('carries the blast radius into the response, the message and the audit row', async () => {
    mocks.deleteTeam.mockResolvedValue({
      id: 'team-1',
      name: 'Team Rocket',
      slug: 'team-rocket',
      removedFromProvider: true,
      reposDeleted: 3,
      deletedRepoNames: ['hw1-team-rocket', 'hw2-team-rocket', 'hw3-team-rocket'],
    });

    const payload = parse(await teamDeleteTool.handler(ARGS, CTX));
    expect(payload.repos_deleted).toBe(3);
    expect(payload.deleted_repo_names).toEqual([
      'hw1-team-rocket',
      'hw2-team-rocket',
      'hw3-team-rocket',
    ]);
    expect(payload.message).toContain('3 linked repository record(s)');

    // The repo records are gone, so the audit trail is the only remaining
    // record of what the delete took with it.
    expect(auditRow().data).toMatchObject({
      repos_deleted: 3,
      deleted_repo_names: ['hw1-team-rocket', 'hw2-team-rocket', 'hw3-team-rocket'],
    });
  });

  it('refuses an unknown / cross-classroom team and audits nothing', async () => {
    mocks.deleteTeam.mockRejectedValue(
      new TeamServiceError('team_not_found', '[team] no team "nope" in classroom class-1')
    );

    await expect(teamDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Team not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('requires confirm:true in the schema (destructive gate)', () => {
    // The registry validates inputSchema before the handler runs, so the gate
    // lives in the schema: only the literal `true` is accepted.
    const confirm = teamDeleteTool.inputSchema.confirm;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
  });
});

describe('team_rename', () => {
  const ARGS = { classroom: 'org/w26', team: 'team-rocket', new_name: 'Team Magma' };

  it('renames via the service and audits the UPDATE', async () => {
    mocks.renameTeam.mockResolvedValue({
      teamId: 'team-1',
      newName: 'Team Magma',
      newSlug: 'team-magma',
      renamedRepos: ['hw1-team-magma'],
      failed: [],
    });

    const payload = parse(await teamRenameTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      team_id: 'team-1',
      new_name: 'Team Magma',
      new_slug: 'team-magma',
      renamed_repos: ['hw1-team-magma'],
      failed: [],
      failed_count: 0,
    });
    expect(payload.warning).toBeUndefined();

    expect(mocks.renameTeam).toHaveBeenCalledWith({
      classroomId: 'class-1',
      slugOrId: 'team-rocket',
      newName: 'Team Magma',
    });

    const audit = auditRow();
    expect(audit.action).toBe('UPDATE');
    expect(audit.resource_id).toBe('team-1');
    expect(audit.data).toMatchObject({ tool: 'team_rename', new_slug: 'team-magma' });
  });

  it('surfaces failed repository renames prominently (they cannot be retried)', async () => {
    mocks.renameTeam.mockResolvedValue({
      teamId: 'team-1',
      newName: 'Team Magma',
      newSlug: 'team-magma',
      renamedRepos: ['hw1-team-magma'],
      failed: [{ name: 'hw2-team-rocket', error: 'provider_error' }],
    });

    const payload = parse(await teamRenameTool.handler(ARGS, CTX));
    // The service's closed reason vocabulary, plus its phrase — never a raw
    // provider message.
    expect(payload.failed).toEqual([
      {
        name: 'hw2-team-rocket',
        error: 'provider_error',
        error_description: expect.any(String),
      },
    ]);
    expect(payload.failed_count).toBe(1);
    // Top-level, not buried: the client must not miss a partial rename.
    expect(payload.warning).toContain('hw2-team-rocket');
    expect(payload.warning).toContain('by hand');
    expect(payload.message).toContain('old name');
    // The failure is on the audit row too.
    expect(auditRow().data).toMatchObject({ failed_repos: ['hw2-team-rocket'] });
  });

  it('refuses an unknown / cross-classroom team and audits nothing', async () => {
    mocks.renameTeam.mockRejectedValue(
      new TeamServiceError('team_not_found', '[team] no team "nope" in classroom class-1')
    );

    await expect(teamRenameTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Team not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps provider_unsupported to invalid_params', async () => {
    mocks.renameTeam.mockRejectedValue(
      new TeamServiceError(
        'provider_unsupported',
        '[team] renaming a team is only supported for GitHub organizations'
      )
    );

    await expect(teamRenameTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
      message: 'renaming a team is only supported for GitHub organizations',
    });
  });
});

describe('team_members_add', () => {
  const ARGS = { classroom: 'org/w26', team: 'team-rocket', logins: ['ada', 'Grace'] };

  it('adds classroom members via the service and audits the UPDATE', async () => {
    mocks.addTeamMembers.mockResolvedValue({
      succeeded: [{ login: 'ada' }],
      failed: [{ login: 'Grace', error: 'provider_error' }],
    });

    const payload = parse(await teamMembersAddTool.handler(ARGS, CTX));
    expect(payload).toEqual({
      success: true,
      team_id: 'team-1',
      team_slug: 'team-rocket',
      succeeded: ['ada'],
      succeeded_count: 1,
      failed: [{ login: 'Grace', error: 'provider_error', error_description: expect.any(String) }],
      failed_count: 1,
    });
    expectNoServiceRowLeak(payload);

    expect(mocks.addTeamMembers).toHaveBeenCalledWith({
      classroomId: 'class-1',
      slugOrId: 'team-rocket',
      logins: ['ada', 'Grace'],
    });

    const audit = auditRow();
    expect(audit.action).toBe('UPDATE');
    expect(audit.classroom_id).toBe('class-1');
    // addTeamMembers returns no team id, so the team is resolved first purely
    // to keep the audit row (and its dedup key) team-specific.
    expect(audit.resource_id).toBe('team-1');
    expect(audit.data).toMatchObject({ tool: 'team_members_add', succeeded: ['ada'] });
  });

  it('rejects logins that are not classroom members BEFORE any service call', async () => {
    await expect(
      teamMembersAddTool.handler({ ...ARGS, logins: ['ada', 'mallory'] }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      data: { logins: ['mallory'] },
    });

    // Nothing was attempted: no GitHub call, no membership write, no audit row.
    for (const mock of teamAdminMocks()) expect(mock).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('matches classroom membership case-insensitively and dedupes repeats', async () => {
    mocks.addTeamMembers.mockResolvedValue({ succeeded: [{ login: 'ada' }], failed: [] });

    // 'Ada', '@ada' and 'ada' are one person; 'grace' matches the stored 'Grace'.
    await teamMembersAddTool.handler({ ...ARGS, logins: ['Ada', '@ada', 'grace'] }, CTX);

    expect(mocks.addTeamMembers).toHaveBeenCalledWith(
      expect.objectContaining({ logins: ['Ada', 'grace'] })
    );
  });

  it('refuses an unknown / cross-classroom team before the membership check', async () => {
    mocks.findTeamsByClassroomId.mockResolvedValue([TEAM_ROW]);

    await expect(
      teamMembersAddTool.handler({ ...ARGS, team: 'not-a-team' }, CTX)
    ).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Team not found in this classroom',
    });

    // The team lookup is classroom-scoped, and nothing else ran — not even the
    // membership check, which is what "before" means here.
    expect(mocks.findTeamsByClassroomId).toHaveBeenCalledWith('class-1');
    expect(mocks.findMembershipsByClassroomId).not.toHaveBeenCalled();
    for (const mock of teamAdminMocks()) expect(mock).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('team_member_remove', () => {
  const ARGS = { classroom: 'org/w26', team: 'team-rocket', login: 'ada' };

  it('removes via the service and audits the UPDATE', async () => {
    mocks.removeTeamMember.mockResolvedValue({ teamId: 'team-1', login: 'ada', removed: true });

    const payload = parse(await teamMemberRemoveTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      team_id: 'team-1',
      login: 'ada',
      removed: true,
    });

    expect(mocks.removeTeamMember).toHaveBeenCalledWith({
      classroomId: 'class-1',
      slugOrId: 'team-rocket',
      login: 'ada',
    });

    const audit = auditRow();
    expect(audit.action).toBe('UPDATE');
    expect(audit.resource_id).toBe('team-1');
    expect(audit.data).toMatchObject({ tool: 'team_member_remove', removed: true });
  });

  it('is idempotent: a non-member still succeeds and reports removed:false', async () => {
    mocks.removeTeamMember.mockResolvedValue({ teamId: 'team-1', login: 'ada', removed: false });

    const payload = parse(await teamMemberRemoveTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ success: true, removed: false });
    expect(payload.message).toContain('no membership row');
    expect(teamMemberRemoveTool.annotations).toMatchObject({ idempotent: true });
  });

  it('keeps mapping the service user_not_found as a backstop', async () => {
    // The pre-check makes this branch unreachable through the tool, but the
    // mapping stays: the service is the shared path, not a private one.
    mocks.removeTeamMember.mockRejectedValue(
      new TeamServiceError('user_not_found', '[team] no user with login nope')
    );

    await expect(teamMemberRemoveTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'No Classmoji user with that login',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a login that is not a classroom member BEFORE any service call', async () => {
    await expect(
      teamMemberRemoveTool.handler({ ...ARGS, login: 'mallory' }, CTX)
    ).rejects.toMatchObject({
      kind: 'invalid_params',
      data: { logins: ['mallory'] },
    });

    for (const mock of teamAdminMocks()) expect(mock).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('answers a login with no Classmoji user exactly as it answers a non-member', async () => {
    // Both refusals must look identical, so the tool never reports whether an
    // account exists on the platform.
    const nonMember = await teamMemberRemoveTool
      .handler({ ...ARGS, login: 'grace-from-another-class' }, CTX)
      .catch((e: unknown) => e);
    const unknownUser = await teamMemberRemoveTool
      .handler({ ...ARGS, login: 'nobody-at-all' }, CTX)
      .catch((e: unknown) => e);

    const shape = (e: unknown) => ({
      kind: (e as { kind: string }).kind,
      message: (e as { message: string }).message.replace(/: .*$/, ''),
    });
    expect(shape(nonMember)).toEqual(shape(unknownUser));
    expect(shape(nonMember).kind).toBe('invalid_params');
  });

  it('matches classroom membership case-insensitively', async () => {
    mocks.removeTeamMember.mockResolvedValue({ teamId: 'team-1', login: 'Grace', removed: true });

    // The roster stores 'Grace'; '@grace' is the same person.
    await teamMemberRemoveTool.handler({ ...ARGS, login: '@grace' }, CTX);

    expect(mocks.removeTeamMember).toHaveBeenCalledWith(
      expect.objectContaining({ login: '@grace' })
    );
  });

  it('refuses an unknown / cross-classroom team', async () => {
    mocks.removeTeamMember.mockRejectedValue(
      new TeamServiceError('team_not_found', '[team] no team "nope" in classroom class-1')
    );

    await expect(teamMemberRemoveTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Team not found in this classroom',
    });
  });
});

describe('team_tag_add', () => {
  const ARGS = { classroom: 'org/w26', team: 'team-rocket', tag_ids: ['tag-1', 'tag-9'] };

  it('attaches tags via the service and audits the UPDATE', async () => {
    mocks.addTeamTags.mockResolvedValue({
      added: ['tag-1'],
      failed: [{ tagId: 'tag-9', error: 'invalid' }],
    });

    const payload = parse(await teamTagAddTool.handler(ARGS, CTX));
    expect(payload).toEqual({
      success: true,
      team_id: 'team-1',
      team_slug: 'team-rocket',
      added: ['tag-1'],
      added_count: 1,
      failed: [{ tag_id: 'tag-9', error: 'invalid', error_description: expect.any(String) }],
      failed_count: 1,
    });
    expectNoServiceRowLeak(payload);

    expect(mocks.addTeamTags).toHaveBeenCalledWith({
      classroomId: 'class-1',
      slugOrId: 'team-rocket',
      tagIds: ['tag-1', 'tag-9'],
    });

    const audit = auditRow();
    expect(audit.resource_id).toBe('team-1');
    expect(audit.data).toMatchObject({ tool: 'team_tag_add', added: ['tag-1'] });
  });

  it('refuses an unknown / cross-classroom team with zero service calls', async () => {
    await expect(
      teamTagAddTool.handler({ ...ARGS, team: 'other-class-team' }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found', message: 'Team not found in this classroom' });
    for (const mock of teamAdminMocks()) expect(mock).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('team_tag_remove', () => {
  const REMOVED = { teamTagId: 'tt-1', teamId: 'team-1', tagId: 'tag-1' };

  it('resolves the TeamTag row from a tag name and detaches it via the service', async () => {
    mocks.removeTeamTag.mockResolvedValue(REMOVED);

    const payload = parse(
      await teamTagRemoveTool.handler(
        { classroom: 'org/w26', team: 'team-rocket', tag_name: 'frontend' },
        CTX
      )
    );
    expect(payload).toEqual({
      success: true,
      team_id: 'team-1',
      team_slug: 'team-rocket',
      tag_id: 'tag-1',
      tag_name: 'frontend',
      team_tag_id: 'tt-1',
    });
    expectNoServiceRowLeak(payload);

    // The row id is resolved in-handler (list_teams exposes tag names only) and
    // the service stays the single mutation path.
    expect(mocks.removeTeamTag).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamTagId: 'tt-1',
    });

    const audit = auditRow();
    expect(audit.action).toBe('UPDATE');
    expect(audit.resource_id).toBe('team-1');
    expect(audit.data).toMatchObject({ tool: 'team_tag_remove', tag_id: 'tag-1' });
  });

  it('accepts a tag id as well', async () => {
    mocks.removeTeamTag.mockResolvedValue({ ...REMOVED, teamTagId: 'tt-2', tagId: 'tag-2' });

    const payload = parse(
      await teamTagRemoveTool.handler(
        { classroom: 'org/w26', team: 'team-1', tag_id: 'tag-2' },
        CTX
      )
    );
    expect(payload).toMatchObject({ tag_id: 'tag-2', team_tag_id: 'tt-2' });
    expect(mocks.removeTeamTag).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamTagId: 'tt-2',
    });
  });

  it('falls back to a case-insensitive name match', async () => {
    mocks.removeTeamTag.mockResolvedValue(REMOVED);

    await teamTagRemoveTool.handler(
      { classroom: 'org/w26', team: 'team-rocket', tag_name: 'FrontEnd' },
      CTX
    );
    expect(mocks.removeTeamTag).toHaveBeenCalledWith({ classroomId: 'class-1', teamTagId: 'tt-1' });
  });

  it('refuses an ambiguous case-insensitive name instead of guessing', async () => {
    mocks.findTeamsByClassroomId.mockResolvedValue([
      {
        ...TEAM_ROW,
        tags: [
          { id: 'tt-1', tag_id: 'tag-1', tag: { id: 'tag-1', name: 'frontend' } },
          { id: 'tt-3', tag_id: 'tag-3', tag: { id: 'tag-3', name: 'Frontend' } },
        ],
      },
    ]);

    await expect(
      teamTagRemoveTool.handler(
        { classroom: 'org/w26', team: 'team-rocket', tag_name: 'FRONTEND' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.removeTeamTag).not.toHaveBeenCalled();
  });

  it('prefers the exact name when a case-variant also exists', async () => {
    mocks.findTeamsByClassroomId.mockResolvedValue([
      {
        ...TEAM_ROW,
        tags: [
          { id: 'tt-1', tag_id: 'tag-1', tag: { id: 'tag-1', name: 'frontend' } },
          { id: 'tt-3', tag_id: 'tag-3', tag: { id: 'tag-3', name: 'Frontend' } },
        ],
      },
    ]);
    mocks.removeTeamTag.mockResolvedValue({ ...REMOVED, teamTagId: 'tt-3', tagId: 'tag-3' });

    await teamTagRemoveTool.handler(
      { classroom: 'org/w26', team: 'team-rocket', tag_name: 'Frontend' },
      CTX
    );
    expect(mocks.removeTeamTag).toHaveBeenCalledWith({ classroomId: 'class-1', teamTagId: 'tt-3' });
  });

  it('refuses a tag that is not on this team (uniform scopedNotFound)', async () => {
    await expect(
      teamTagRemoveTool.handler(
        { classroom: 'org/w26', team: 'team-rocket', tag_name: 'backend' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found', message: 'Tag not found in this classroom' });
    expect(mocks.removeTeamTag).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses an unknown / cross-classroom team with zero service calls', async () => {
    await expect(
      teamTagRemoveTool.handler(
        { classroom: 'org/w26', team: 'other-class-team', tag_name: 'frontend' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found', message: 'Team not found in this classroom' });
    expect(mocks.findTeamsByClassroomId).toHaveBeenCalledWith('class-1');
    for (const mock of teamAdminMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it('requires one of tag_name / tag_id', async () => {
    await expect(
      teamTagRemoveTool.handler({ classroom: 'org/w26', team: 'team-rocket' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params', message: 'Provide tag_name or tag_id' });
    expect(mocks.findTeamsByClassroomId).not.toHaveBeenCalled();
  });
});

describe('tool declarations', () => {
  const TOOLS = [
    teamCreateTool,
    teamDeleteTool,
    teamRenameTool,
    teamMembersAddTool,
    teamMemberRemoveTool,
    teamTagAddTool,
    teamTagRemoveTool,
  ];

  it('are all OWNER-only write tools taking a classroom argument', () => {
    for (const tool of TOOLS) {
      expect(tool.scope).toBe('write');
      expect(tool.roles).toEqual(['OWNER']);
      expect(tool.inputSchema.classroom).toBeDefined();
    }
  });

  it('declare the GitHub-touching tools as openWorld and the tag tools as local', () => {
    for (const tool of [
      teamCreateTool,
      teamDeleteTool,
      teamRenameTool,
      teamMembersAddTool,
      teamMemberRemoveTool,
    ]) {
      expect(tool.annotations?.openWorld).toBe(true);
    }
    expect(teamTagAddTool.annotations?.openWorld).toBe(false);
    expect(teamTagRemoveTool.annotations?.openWorld).toBe(false);
  });

  it('flag the removals as destructive and the additions as not', () => {
    expect(teamDeleteTool.annotations?.destructive).toBe(true);
    expect(teamMemberRemoveTool.annotations?.destructive).toBe(true);
    expect(teamTagRemoveTool.annotations?.destructive).toBe(true);
    expect(teamCreateTool.annotations?.destructive).toBe(false);
    expect(teamRenameTool.annotations?.destructive).toBe(false);
    expect(teamMembersAddTool.annotations?.destructive).toBe(false);
    expect(teamTagAddTool.annotations?.destructive).toBe(false);
  });
});
