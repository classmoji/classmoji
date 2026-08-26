/**
 * Unit tests for the `roster` and `teams` resources (the read side of
 * get_roster / list_teams).
 *
 * Two policies are pinned here:
 *
 * roster — the whole teaching team may read the roster, but the OWNER-only
 * field split is part of the policy, not a detail: contact fields (email,
 * school_id) and the membership grade fields (letter_grade, comment) are
 * present for an OWNER and ABSENT — not null — for a TEACHER or ASSISTANT.
 * The webapp roster route (admin.$class.students) applies the same split in
 * its loader; the two are meant to stay in step.
 *
 * teams — a STUDENT sees the teams they are a member of, and only those.
 * Membership is the whole test: the `is_visible` flag does not widen it. The
 * teaching team continues to see every team in the classroom.
 *
 * `@classmoji/services` is mocked (factory idiom) so the real shaping runs
 * against hand-built rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceDefinition, ToolContext } from '../../mcp/registry.ts';

const findUsersByRole = vi.fn();
const teamFindByClassroomId = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: { findUsersByRole: (...a: unknown[]) => findUsersByRole(...a) },
    team: { findByClassroomId: (...a: unknown[]) => teamFindByClassroomId(...a) },
  },
}));

const { rosterResource, teamsResource } = await import('../roster.ts');

const VARS = { org: 'test-org', slug: 'winter-2025' };
const URI = new URL('classmoji://test-org/winter-2025/roster');

/** Resource handlers take (vars, ctx, uri); the uri is inert for these two. */
const read = async <T>(resource: ResourceDefinition, ctx: ToolContext): Promise<T> =>
  (await resource.handler(VARS, ctx, URI)) as T;

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

function ctxFor(role: Role, userId: string): ToolContext {
  return {
    viewer: { userId, clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { settings: {} },
    },
  } as unknown as ToolContext;
}

const STUDENT_ROW = {
  id: 'student-1',
  name: 'Ada Lovelace',
  login: 'ada',
  image: 'https://example.test/ada.png',
  email: 'ada@school.test',
  school_id: 'F00123',
  is_grader: false,
  has_accepted_invite: true,
  letter_grade: 'A-',
  comment: 'strong on recursion',
};

const OWNER_ONLY_FIELDS = ['email', 'school_id', 'letter_grade', 'comment'] as const;

beforeEach(() => {
  findUsersByRole.mockReset();
  teamFindByClassroomId.mockReset();
  findUsersByRole.mockResolvedValue([STUDENT_ROW]);
});

// ─── roster: teaching-team read, OWNER-only fields ───────────────────────────

describe('roster resource', () => {
  it('gives an OWNER the identity fields plus the contact and grade fields', async () => {
    const payload = await read<{
      count: number;
      students: Array<Record<string, unknown>>;
    }>(rosterResource, ctxFor('OWNER', 'owner-1'));

    expect(payload.count).toBe(1);
    expect(payload.students[0]).toMatchObject({
      id: 'student-1',
      name: 'Ada Lovelace',
      login: 'ada',
      is_grader: false,
      has_accepted_invite: true,
      email: 'ada@school.test',
      school_id: 'F00123',
      letter_grade: 'A-',
      comment: 'strong on recursion',
    });
  });

  it.each([['TEACHER'], ['ASSISTANT']] as const)(
    '%s reads the roster identity fields, with the owner-only fields absent (not null)',
    async role => {
      const payload = await read<{
        count: number;
        students: Array<Record<string, unknown>>;
      }>(rosterResource, ctxFor(role, 'staff-1'));

      expect(payload.count).toBe(1);
      const row = payload.students[0];
      // The roster is readable — identity and status still come through.
      expect(row).toMatchObject({
        id: 'student-1',
        name: 'Ada Lovelace',
        login: 'ada',
        is_grader: false,
        has_accepted_invite: true,
      });
      // The keys must be missing entirely, so nothing to reveal downstream.
      for (const field of OWNER_ONLY_FIELDS) {
        expect(field in row).toBe(false);
      }
      expect(JSON.stringify(payload)).not.toContain('ada@school.test');
      expect(JSON.stringify(payload)).not.toContain('F00123');
    }
  );
});

// ─── teams: a student sees their own teams ───────────────────────────────────

describe('teams resource', () => {
  const member = (id: string) => ({ user: { id, name: id, login: id, image: null } });

  const TEAMS = [
    {
      id: 't-own',
      name: 'Team Own',
      slug: 'team-own',
      is_visible: false,
      memberships: [member('student-1'), member('student-2')],
      tags: [{ tag: { name: 'project-1' } }],
    },
    {
      id: 't-other-visible',
      name: 'Team Other Visible',
      slug: 'team-other-visible',
      is_visible: true,
      memberships: [member('student-3')],
      tags: [],
    },
    {
      id: 't-other-hidden',
      name: 'Team Other Hidden',
      slug: 'team-other-hidden',
      is_visible: false,
      memberships: [member('student-4')],
      tags: [],
    },
  ];

  beforeEach(() => {
    teamFindByClassroomId.mockResolvedValue(TEAMS);
  });

  it('returns a STUDENT only the teams they belong to, whatever is_visible says', async () => {
    const payload = await read<{
      count: number;
      teams: Array<Record<string, unknown>>;
    }>(teamsResource, ctxFor('STUDENT', 'student-1'));

    expect(payload.count).toBe(1);
    expect(payload.teams.map(t => t.id)).toEqual(['t-own']);
    // The one visible team the student is not on is not part of their list.
    expect(payload.teams.map(t => t.id)).not.toContain('t-other-visible');
  });

  it('returns an empty list for a STUDENT on no team', async () => {
    const payload = await read<{ count: number; teams: unknown[] }>(
      teamsResource,
      ctxFor('STUDENT', 'student-99')
    );

    expect(payload.count).toBe(0);
    expect(payload.teams).toEqual([]);
  });

  it.each([['OWNER'], ['TEACHER'], ['ASSISTANT']] as const)(
    '%s still sees every team in the classroom',
    async role => {
      const payload = await read<{
        count: number;
        teams: Array<Record<string, unknown>>;
      }>(teamsResource, ctxFor(role, 'staff-1'));

      expect(payload.count).toBe(3);
      expect(payload.teams.map(t => t.id)).toEqual(['t-own', 't-other-visible', 't-other-hidden']);
    }
  );

  it('keeps the row shape narrow: public identity only, plus tag names', async () => {
    const payload = await read<{ teams: Array<Record<string, unknown>> }>(
      teamsResource,
      ctxFor('STUDENT', 'student-1')
    );

    expect(payload.teams[0]).toEqual({
      id: 't-own',
      name: 'Team Own',
      slug: 'team-own',
      is_visible: false,
      members: [
        { id: 'student-1', name: 'student-1', login: 'student-1', avatar: null },
        { id: 'student-2', name: 'student-2', login: 'student-2', avatar: null },
      ],
      tags: ['project-1'],
    });
  });
});
