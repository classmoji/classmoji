/**
 * Unit tests for roster.addStudents — the extracted bulk-add logic shared by
 * the web "Add Students" action and the MCP roster_add_student tool. Prisma and
 * the classroom service are mocked; the test pins the existing-vs-invite split,
 * case-insensitive email matching, that composed emails are RETURNED (the
 * service never triggers them — the caller does), that the memberships and the
 * invites commit in ONE transaction (#372), and that students already in the
 * class are skipped and reported.
 *
 * The REAL classroomInvite service runs (only Prisma is mocked), so the invite
 * write is asserted as the row Prisma receives. The membership and invite
 * models exist ONLY on the transaction client: a write that escaped the
 * transaction would hit the root client and throw.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userFindMany = vi.fn();
const accountFindMany = vi.fn();
/** Users already holding a STUDENT row here: the insert skips them as duplicates. */
const alreadyIn = new Set<string>();
const membershipCreateMany = vi.fn();
const inviteCreateMany = vi.fn();
const transaction = vi.fn();
const tx = {
  classroomMembership: {
    createManyAndReturn: (...a: unknown[]) => membershipCreateMany(...a),
  },
  classroomInvite: { createMany: (...a: unknown[]) => inviteCreateMany(...a) },
};
vi.mock('@classmoji/database', () => ({
  default: () => ({
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    account: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  }),
}));

const classroomFindById = vi.fn();
vi.mock('../classroom.service.ts', () => ({
  findById: (...a: unknown[]) => classroomFindById(...a),
}));

const roster = await import('../roster.service.ts');

beforeEach(() => {
  for (const m of [
    userFindMany,
    accountFindMany,
    membershipCreateMany,
    inviteCreateMany,
    transaction,
    classroomFindById,
  ]) {
    m.mockReset();
  }
  classroomFindById.mockResolvedValue({ id: 'class-1', name: 'CS1' });
  alreadyIn.clear();
  // createManyAndReturn with skipDuplicates: returns only the rows it inserted.
  membershipCreateMany.mockImplementation(({ data }: { data: { user_id: string }[] }) =>
    Promise.resolve(
      data.filter(row => !alreadyIn.has(row.user_id)).map(row => ({ user_id: row.user_id }))
    )
  );
  inviteCreateMany.mockResolvedValue({ count: 1 });
  // An interactive transaction: run the callback against the tx client; a
  // throw inside it rejects the whole call (Prisma rolls back).
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
});

describe('roster.addStudents', () => {
  it('invites an unknown email with no name using an empty student_name (NOT NULL column)', async () => {
    userFindMany.mockResolvedValue([]);

    await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'noname@x.edu' }],
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(inviteCreateMany).toHaveBeenCalledWith({
      data: [{ school_email: 'noname@x.edu', classroom_id: 'class-1', student_name: '' }],
      skipDuplicates: true,
    });
  });

  it('enrolls existing users, invites unknown emails, and returns both email sets', async () => {
    userFindMany.mockResolvedValue([{ id: 'u-existing', email: 'known@x.edu', name: 'Known' }]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [
        { email: 'known@x.edu', name: 'K' },
        { email: 'new@x.edu', name: 'New' },
      ],
    });

    expect(result.addedExistingUsers).toBe(1);
    expect(result.invitedNewUsers).toBe(1);

    expect(result.alreadyEnrolled).toEqual([]);

    // Both writes went through the one transaction (the models exist only on
    // the tx client).
    expect(transaction).toHaveBeenCalledTimes(1);
    // Existing user → membership with has_accepted_invite:false.
    expect(membershipCreateMany).toHaveBeenCalledWith({
      data: [
        {
          classroom_id: 'class-1',
          user_id: 'u-existing',
          role: 'STUDENT',
          has_accepted_invite: false,
        },
      ],
      skipDuplicates: true,
      select: { user_id: true },
    });
    // Unknown email → invite row.
    expect(inviteCreateMany).toHaveBeenCalledWith({
      data: [{ school_email: 'new@x.edu', classroom_id: 'class-1', student_name: 'New' }],
      skipDuplicates: true,
    });

    // Subjects now live on the Resend templates, so the payload carries a
    // template id plus variables rather than a rendered subject and body.
    expect(result.emails).toHaveLength(2);
    expect(result.emails[0].payload.template.id).toBe('roster-added');
    expect(result.emails[0].payload.template.variables.CLASSROOM_NAME).toBe('CS1');
    expect(result.emails[1].payload.template.id).toBe('roster-invited');
    expect(result.emails[1].payload.template.variables.CLASSROOM_NAME).toBe('CS1');
  });

  it('sends invitees a link that carries a signed token for their address', async () => {
    // The link used to be the same for everyone, so a student who retyped a
    // different address at sign-up never matched their invite (#343).
    userFindMany.mockResolvedValue([]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'New.Student@x.edu', name: 'New' }],
    });

    const url = result.emails[0].payload.template.variables.APP_URL as string;
    const outer = new URL(url.replace(/&amp;/g, '&'));
    const target = outer.searchParams.get('redirect');
    expect(target).toBe('/select-organization?invite=tok(New.Student%40x.edu)');
  });

  it('escapes user-authored names before they become template variables', async () => {
    // Resend injects variables raw, so an unescaped teacher-typed name would
    // put live markup in the invitee's inbox.
    userFindMany.mockResolvedValue([]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'new@x.edu', name: '<b>Mallory</b>' }],
    });

    expect(result.emails[0].payload.template.variables.STUDENT_NAME).toBe(
      '&lt;b&gt;Mallory&lt;/b&gt;'
    );
  });

  it('falls back to a greeting when the teacher omits the student name', async () => {
    // Previously rendered "Hi undefined!".
    userFindMany.mockResolvedValue([]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'noname@x.edu' }],
    });

    expect(result.emails[0].payload.template.variables.STUDENT_NAME).toBe('there');
  });

  it('matches existing users case-insensitively', async () => {
    userFindMany.mockResolvedValue([{ id: 'u1', email: 'a@x.edu', name: 'A' }]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'A@X.edu' }],
    });

    expect(result.addedExistingUsers).toBe(1);
    expect(result.invitedNewUsers).toBe(0);
    expect(inviteCreateMany).not.toHaveBeenCalled();
  });

  it('rejects, sending nothing, when the invite write fails after the memberships (#372)', async () => {
    // Before, the memberships were committed on their own, so a failed invite
    // write left students enrolled with no invites, no audit row and no email.
    userFindMany.mockResolvedValue([{ id: 'u1', email: 'known@x.edu', name: 'K' }]);
    inviteCreateMany.mockRejectedValue(new Error('invite write failed'));

    await expect(
      roster.addStudents({
        classroomId: 'class-1',
        signInvite: email => `tok(${email})`,
        students: [{ email: 'known@x.edu' }, { email: 'new@x.edu' }],
      })
    ).rejects.toThrow('invite write failed');

    // The membership write happened INSIDE the transaction that rejected, so
    // Prisma rolls it back; nothing outside the transaction wrote anything.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(membershipCreateMany).toHaveBeenCalledTimes(1);
    // No result means no emails or activations for the caller to send.
  });

  it('skips students already in the class: no write, no email, not counted, reported', async () => {
    userFindMany.mockResolvedValue([
      { id: 'u-in', email: 'in@x.edu', name: 'In' },
      { id: 'u-new', email: 'fresh@x.edu', name: 'Fresh' },
    ]);
    alreadyIn.add('u-in');

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'In@x.edu' }, { email: 'fresh@x.edu' }],
    });

    // Both rows are offered; the unique key skips the one already enrolled.
    expect(membershipCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ user_id: 'u-in' }),
        expect.objectContaining({ user_id: 'u-new' }),
      ],
      skipDuplicates: true,
      select: { user_id: true },
    });
    expect(result.addedExistingUsers).toBe(1);
    expect(result.invitedNewUsers).toBe(0);
    // Reported as the owner typed the address.
    expect(result.alreadyEnrolled).toEqual(['In@x.edu']);
    expect(result.emails.map(e => e.payload.to)).toEqual(['fresh@x.edu']);
  });

  it('enrolls no one and sends nothing when everyone is already enrolled', async () => {
    userFindMany.mockResolvedValue([{ id: 'u-in', email: 'in@x.edu', name: 'In' }]);
    alreadyIn.add('u-in');

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'in@x.edu' }],
    });

    // The insert ran and wrote nothing new.
    expect(membershipCreateMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      addedExistingUsers: 0,
      invitedNewUsers: 0,
      alreadyEnrolled: ['in@x.edu'],
      emails: [],
      activations: [],
    });
  });

  it('does not activate a Gitlab student who is already enrolled', async () => {
    classroomFindById.mockResolvedValue({
      id: 'class-1',
      name: 'CS1',
      git_organization: { id: 'org-1', provider: 'GITLAB', gitlab_instance_id: null },
    });
    userFindMany.mockResolvedValue([
      { id: 'u-in', email: 'in@x.edu', name: 'In' },
      { id: 'u-new', email: 'fresh@x.edu', name: 'Fresh' },
    ]);
    alreadyIn.add('u-in');
    // Both have a gitlab.com account (no instance prefix on the id).
    accountFindMany.mockResolvedValue([
      { user_id: 'u-in', account_id: '11', username: 'in-gl' },
      { user_id: 'u-new', account_id: '12', username: 'fresh-gl' },
    ]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'in@x.edu' }, { email: 'fresh@x.edu' }],
    });

    expect(result.activations).toEqual([{ login: 'fresh-gl', gitOrganizationId: 'org-1' }]);
    expect(membershipCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ user_id: 'u-in' }),
        expect.objectContaining({ user_id: 'u-new', has_accepted_invite: true }),
      ],
      skipDuplicates: true,
      select: { user_id: true },
    });
  });

  it('treats the same address listed twice as one student', async () => {
    userFindMany.mockResolvedValue([]);

    const result = await roster.addStudents({
      classroomId: 'class-1',
      signInvite: email => `tok(${email})`,
      students: [{ email: 'dup@x.edu', name: 'D' }, { email: 'DUP@x.edu' }],
    });

    expect(result.invitedNewUsers).toBe(1);
    expect(result.emails).toHaveLength(1);
    expect(inviteCreateMany).toHaveBeenCalledWith({
      data: [{ school_email: 'dup@x.edu', classroom_id: 'class-1', student_name: 'D' }],
      skipDuplicates: true,
    });
  });

  it('throws when the classroom does not exist', async () => {
    classroomFindById.mockResolvedValue(null);
    await expect(
      roster.addStudents({
        classroomId: 'nope',
        students: [{ email: 'a@x.edu' }],
        signInvite: () => 'tok',
      })
    ).rejects.toThrow(/classroom/);
  });
});
