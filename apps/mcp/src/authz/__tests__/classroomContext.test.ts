/**
 * Unit tests for resolveClassroomContext's ambiguity guard (finding A1) and
 * deterministic multi-role resolution (finding U6).
 *
 * A1: resolving through findAll returns a LIST, and a list of surprising length
 * must never be silently reduced to matches[0]. Classroom.slug is globally
 * unique today, so more than one match cannot occur in practice and the guard
 * is defense in depth — but it must hold: a >1 match has to be refused with a
 * non-leaking `not_found`. A normal unambiguous reference must still resolve;
 * a zero-match must stay an indistinguishable clean not_found.
 *
 * U6: ClassroomMembership is unique on (classroom_id, user_id, role) and
 * findByClassroomAndUser is an UNORDERED findFirst, so a single role-filtered
 * lookup hands back an ARBITRARY role for a multi-role user. The resolver must
 * resolve the HIGHEST-privilege matching role deterministically (OWNER >
 * TEACHER > ASSISTANT > STUDENT) and expose the full matching set as
 * ctx.roles.
 *
 * `@classmoji/services` is mocked (factory idiom per packages/services
 * __tests__) so classroom/membership rows are hand-built and the resolver's
 * own decisions run for real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { ToolError } from '../../mcp/errors.ts';
import type { Viewer } from '../../auth/resolveViewer.ts';

const findAll = vi.fn();
const findByClassroomAndUser = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      findAll: (...args: unknown[]) => findAll(...args),
      getClassroomForUI: (c: unknown) => c,
      getTimeZone: async () => 'America/New_York',
    },
    classroomMembership: {
      findByClassroomAndUser: (...args: unknown[]) => findByClassroomAndUser(...args),
    },
  },
}));

const { resolveClassroomContext } = await import('../classroomContext.ts');

const VIEWER: Viewer = { userId: 'user-1', clientId: 'client-1', scopes: new Set(['read']) };
const REF = 'classmoji-dev/winter-2025';

function classroomRow(id: string, overrides: Record<string, unknown> = {}) {
  return { id, status: 'ACTIVE', slug: 'winter-2025', ...overrides };
}

/**
 * Faithful mock of the real service findFirst: given the roles the user holds,
 * answer role-filtered lookups accordingly (unfiltered → first held role).
 */
function holdRoles(...held: Role[]) {
  findByClassroomAndUser.mockImplementation((_cid: string, _uid: string, roles: Role[] | null) => {
    const match = roles ? held.find(r => roles.includes(r)) : held[0];
    return Promise.resolve(match ? { id: `membership-${match}`, role: match } : null);
  });
}

beforeEach(() => {
  findAll.mockReset();
  findByClassroomAndUser.mockReset();
});

describe('resolveClassroomContext ambiguity guard (A1)', () => {
  it('REFUSES an ambiguous org/slug match with not_found', async () => {
    // Two rows come back for one reference. Unreachable while the slug is
    // globally unique; the guard has to hold anyway.
    findAll.mockResolvedValue([classroomRow('twin-a'), classroomRow('twin-b')]);

    const err = await resolveClassroomContext(VIEWER, REF).catch(e => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('not_found');
    // Refused BEFORE any membership lookup — never resolves to one twin.
    expect(findByClassroomAndUser).not.toHaveBeenCalled();
  });

  it('keeps a zero-match as an indistinguishable clean not_found (no existence leak)', async () => {
    findAll.mockResolvedValue([]);

    const err = await resolveClassroomContext(VIEWER, REF).catch(e => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('not_found');
    expect(findByClassroomAndUser).not.toHaveBeenCalled();
  });

  it('still resolves a normal unambiguous reference to its classroom context', async () => {
    findAll.mockResolvedValue([classroomRow('the-one')]);
    holdRoles('STUDENT');

    const ctx = await resolveClassroomContext(VIEWER, REF);
    expect(ctx.classroomId).toBe('the-one');
    expect(ctx.role).toBe('STUDENT');
    expect(ctx.roles).toEqual(['STUDENT']);
    expect(findByClassroomAndUser).toHaveBeenCalled();
    // The classroom's zone rides along for the class-zone renderings, and it
    // outranks any caller hint.
    expect(ctx.timezone).toBe('America/New_York');
    expect(ctx.effectiveTimezone).toEqual({ timeZone: 'America/New_York', source: 'classroom' });
    const hinted = await resolveClassroomContext({ ...VIEWER, timezoneHint: 'Europe/Paris' }, REF);
    expect(hinted.effectiveTimezone.source).toBe('classroom');
  });
});

describe('deterministic multi-role resolution (U6)', () => {
  beforeEach(() => {
    findAll.mockResolvedValue([classroomRow('the-one')]);
  });

  it('resolves an OWNER+ASSISTANT caller to OWNER under a teaching-team gate', async () => {
    holdRoles('ASSISTANT', 'OWNER'); // held order must not matter

    const ctx = await resolveClassroomContext(VIEWER, REF, {
      allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    });
    expect(ctx.role).toBe('OWNER');
    expect(ctx.membership.role).toBe('OWNER');
    // Full matching set, highest privilege first.
    expect(ctx.roles).toEqual(['OWNER', 'ASSISTANT']);
  });

  it('resolves an ASSISTANT+STUDENT caller to ASSISTANT under an any-member gate', async () => {
    // The `list_slides` surface shape (roles: MEMBER). Its handler branches on
    // ctx.role via isStaff(), so a TA who is also enrolled as a student has to
    // resolve as staff here or the deck listing silently narrows for them.
    holdRoles('STUDENT', 'ASSISTANT'); // held order must not matter

    const ctx = await resolveClassroomContext(VIEWER, REF, {
      allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    });
    expect(ctx.role).toBe('ASSISTANT');
    expect(ctx.roles).toEqual(['ASSISTANT', 'STUDENT']);
  });

  it('resolves an OWNER+STUDENT caller to OWNER under an any-member gate', async () => {
    holdRoles('STUDENT', 'OWNER');

    const ctx = await resolveClassroomContext(VIEWER, REF, {
      allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    });
    expect(ctx.role).toBe('OWNER');
    expect(ctx.roles).toEqual(['OWNER', 'STUDENT']);
  });

  it('only considers roles the gate allows (OWNER+STUDENT under a student-only gate)', async () => {
    holdRoles('OWNER', 'STUDENT');

    const ctx = await resolveClassroomContext(VIEWER, REF, { allowedRoles: ['STUDENT'] });
    expect(ctx.role).toBe('STUDENT');
    expect(ctx.roles).toEqual(['STUDENT']);
  });

  it('keeps INSUFFICIENT_ROLE distinct from NOT_A_MEMBER', async () => {
    holdRoles('STUDENT');
    const insufficient = await resolveClassroomContext(VIEWER, REF, {
      allowedRoles: ['OWNER'],
    }).catch(e => e);
    expect(insufficient).toBeInstanceOf(ToolError);
    expect((insufficient as ToolError).code).toBe('INSUFFICIENT_ROLE');

    holdRoles(); // holds nothing — not a member at all
    const notMember = await resolveClassroomContext(VIEWER, REF, {
      allowedRoles: ['OWNER'],
    }).catch(e => e);
    expect(notMember).toBeInstanceOf(ToolError);
    expect((notMember as ToolError).code).toBe('NOT_A_MEMBER');
  });
});

describe('role ceiling (Ask Moji view)', () => {
  const MEMBER: Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];
  const TEACHING_TEAM: Role[] = ['OWNER', 'TEACHER', 'ASSISTANT'];
  const capped = (ceiling: Role, base: Viewer = VIEWER): Viewer => ({
    ...base,
    roleCeiling: ceiling,
  });

  /** Roles held per `${classroomId}:${userId}`; same findFirst semantics as holdRoles. */
  function holdRolesBy(held: Record<string, Role[]>) {
    findByClassroomAndUser.mockImplementation((cid: string, uid: string, roles: Role[] | null) => {
      const mine = held[`${cid}:${uid}`] ?? [];
      const match = roles ? mine.find(r => roles.includes(r)) : mine[0];
      return Promise.resolve(
        match ? { id: `membership-${cid}-${uid}-${match}`, role: match } : null
      );
    });
  }

  beforeEach(() => {
    findAll.mockResolvedValue([classroomRow('the-one')]);
  });

  it('resolves a TA who is also a STUDENT as STUDENT on an any-member surface', async () => {
    // list_repos / list_slides shape: the handler branches on ctx.role, so the
    // capped TA has to land on the student branch.
    holdRoles('ASSISTANT', 'STUDENT');

    const uncapped = await resolveClassroomContext(VIEWER, REF, { allowedRoles: MEMBER });
    expect(uncapped.role).toBe('ASSISTANT');

    const ctx = await resolveClassroomContext(capped('STUDENT'), REF, { allowedRoles: MEMBER });
    expect(ctx.role).toBe('STUDENT');
    expect(ctx.membership.role).toBe('STUDENT');
    expect(ctx.roles).toEqual(['STUDENT']);
  });

  it('lets the capped TA+STUDENT reach the student-only my_* surfaces', async () => {
    holdRoles('ASSISTANT', 'STUDENT');
    const ctx = await resolveClassroomContext(capped('STUDENT'), REF, {
      allowedRoles: ['STUDENT'],
    });
    expect(ctx.role).toBe('STUDENT');
  });

  it('refuses the capped TA+STUDENT on a teaching-team surface, without the unfiltered lookup', async () => {
    // Held order ASSISTANT first: if the unfiltered findFirst ran, it would
    // hand ASSISTANT back and the gate would pass.
    holdRoles('ASSISTANT', 'STUDENT');

    const err = await resolveClassroomContext(capped('STUDENT'), REF, {
      allowedRoles: TEACHING_TEAM,
    }).catch(e => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('forbidden');
    expect((err as ToolError).code).toBe('INSUFFICIENT_ROLE');
    for (const call of findByClassroomAndUser.mock.calls) expect(call[2]).not.toBeNull();
  });

  it('refuses a pure STUDENT with a STUDENT ceiling on get_roster (teaching team)', async () => {
    holdRoles('STUDENT');
    const err = await resolveClassroomContext(capped('STUDENT'), REF, {
      allowedRoles: TEACHING_TEAM,
    }).catch(e => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('forbidden');
    expect((err as ToolError).code).toBe('INSUFFICIENT_ROLE');
  });

  it('fails closed when the ceiling leaves nothing on an any-member surface', async () => {
    // A null / empty allowedRoles means "any member"; the ceiling must never
    // be read as that.
    holdRoles('ASSISTANT');
    for (const allowedRoles of [null, [] as Role[], MEMBER]) {
      const err = await resolveClassroomContext(capped('STUDENT'), REF, { allowedRoles }).catch(
        e => e
      );
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).kind).toBe('forbidden');
    }
  });

  it('caps an OWNER+STUDENT under an empty allowedRoles instead of widening', async () => {
    holdRoles('OWNER', 'STUDENT');
    const ctx = await resolveClassroomContext(capped('STUDENT'), REF, { allowedRoles: [] });
    expect(ctx.role).toBe('STUDENT');
    expect(ctx.roles).toEqual(['STUDENT']);
  });

  it('changes nothing when the ceiling is at or above every role held', async () => {
    holdRoles('STUDENT');
    const student = await resolveClassroomContext(capped('OWNER'), REF, { allowedRoles: MEMBER });
    expect(student.role).toBe('STUDENT');

    holdRoles('ASSISTANT', 'STUDENT');
    const ta = await resolveClassroomContext(capped('ASSISTANT'), REF, { allowedRoles: MEMBER });
    expect(ta.role).toBe('ASSISTANT');
    expect(ta.roles).toEqual(['ASSISTANT', 'STUDENT']);

    holdRoles('OWNER');
    const owner = await resolveClassroomContext(capped('OWNER'), REF, {
      allowedRoles: TEACHING_TEAM,
    });
    expect(owner.role).toBe('OWNER');
  });

  it('keeps NOT_A_MEMBER for a non-member with a ceiling', async () => {
    holdRoles();
    const err = await resolveClassroomContext(capped('STUDENT'), REF, {
      allowedRoles: MEMBER,
    }).catch(e => e);
    expect((err as ToolError).code).toBe('NOT_A_MEMBER');
  });

  it('applies the entry gate to the capped role (an OWNER viewing as STUDENT)', async () => {
    findAll.mockResolvedValue([classroomRow('the-one', { status: 'UNPUBLISHED' })]);
    holdRoles('OWNER', 'STUDENT');

    const owner = await resolveClassroomContext(VIEWER, REF, { allowedRoles: MEMBER });
    expect(owner.role).toBe('OWNER');
    const err = await resolveClassroomContext(capped('STUDENT'), REF, {
      allowedRoles: MEMBER,
    }).catch(e => e);
    expect((err as ToolError).code).toBe('CLASSROOM_UNPUBLISHED');
  });

  it('classroom X vs Y: the ceiling is judged against the roles held in the classroom named', async () => {
    findAll.mockImplementation(async (where: { slug: string }) => [
      classroomRow(where.slug === 'x' ? 'class-x' : 'class-y', { slug: where.slug }),
    ]);
    // TA + student in X, TA only in Y.
    holdRolesBy({
      'class-x:user-1': ['ASSISTANT', 'STUDENT'],
      'class-y:user-1': ['ASSISTANT'],
    });

    const x = await resolveClassroomContext(capped('STUDENT'), 'org/x', { allowedRoles: MEMBER });
    expect(x.classroomId).toBe('class-x');
    expect(x.role).toBe('STUDENT');

    const err = await resolveClassroomContext(capped('STUDENT'), 'org/y', {
      allowedRoles: MEMBER,
    }).catch(e => e);
    expect((err as ToolError).kind).toBe('forbidden');
    for (const [cid] of findByClassroomAndUser.mock.calls) {
      expect(['class-x', 'class-y']).toContain(cid);
    }
  });

  it('user A vs B: each request is capped by its own viewer and looks up its own user', async () => {
    holdRolesBy({
      'the-one:user-a': ['ASSISTANT', 'STUDENT'],
      'the-one:user-b': ['ASSISTANT', 'STUDENT'],
    });
    const a: Viewer = { ...VIEWER, userId: 'user-a', roleCeiling: 'STUDENT' };
    const b: Viewer = { ...VIEWER, userId: 'user-b' };

    const ctxA = await resolveClassroomContext(a, REF, { allowedRoles: MEMBER });
    const ctxB = await resolveClassroomContext(b, REF, { allowedRoles: MEMBER });
    expect(ctxA.role).toBe('STUDENT');
    expect(ctxA.membership.id).toBe('membership-the-one-user-a-STUDENT');
    expect(ctxB.role).toBe('ASSISTANT');
    expect(ctxB.membership.id).toBe('membership-the-one-user-b-ASSISTANT');
  });
});
