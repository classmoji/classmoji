/**
 * `assign_tokens_to_student` — one student's share of a staff grant (the web
 * grant form queues one run per student).
 *
 * Held here: the run grants through `token.grantTokens` with the payload's
 * ids, amount and description, and the actor the payload names (read field by
 * field), or none for a payload queued without one (before it carried one),
 * which then records nothing; its output stays the ledger row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const grantTokens = vi.fn();

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: { token: { grantTokens: (...a: unknown[]) => grantTokens(...a) } },
}));

const { assignTokensToStudentTask } = (await import('../token.ts')) as unknown as {
  assignTokensToStudentTask: { id: string; run: (payload: unknown) => Promise<unknown> };
};

const ROW = { id: 'tx-1', student_id: 'stu-1', amount: 5, balance_after: 12 };
const PAYLOAD = {
  student: { id: 'stu-1', name: 'Ada', login: 'ada' },
  classroomId: 'class-1',
  amount: 5,
  description: 'Lab bonus',
};
const ACTOR = {
  userId: 'owner-1',
  role: 'OWNER',
  tool: 'web:tokens.grant',
  impersonatedBy: 'admin-1',
};

beforeEach(() => {
  grantTokens.mockReset();
  grantTokens.mockResolvedValue({ transaction: ROW, audit: { written: 1, missed: 0 } });
});

describe('assign_tokens_to_student', () => {
  it('grants for the owner the payload names and returns the ledger row', async () => {
    expect(assignTokensToStudentTask.id).toBe('assign_tokens_to_student');

    const output = await assignTokensToStudentTask.run({
      ...PAYLOAD,
      auditActor: { ...ACTOR, name: 'not an actor field' },
    });

    expect(grantTokens).toHaveBeenCalledTimes(1);
    expect(grantTokens).toHaveBeenCalledWith({
      studentId: 'stu-1',
      classroomId: 'class-1',
      amount: 5,
      description: 'Lab bonus',
      actor: ACTOR,
    });
    expect(output).toEqual(ROW);
  });

  it('records nothing for a payload queued without an actor, and still grants', async () => {
    const output = await assignTokensToStudentTask.run({ ...PAYLOAD, description: undefined });

    expect(grantTokens).toHaveBeenCalledWith({
      studentId: 'stu-1',
      classroomId: 'class-1',
      amount: 5,
      description: undefined,
      actor: null,
    });
    expect(output).toEqual(ROW);
  });

  it('records nothing for a payload whose actor is not one', async () => {
    await assignTokensToStudentTask.run({ ...PAYLOAD, auditActor: { userId: 'owner-1' } });
    expect(grantTokens.mock.calls[0][0].actor).toBeNull();
  });
});
