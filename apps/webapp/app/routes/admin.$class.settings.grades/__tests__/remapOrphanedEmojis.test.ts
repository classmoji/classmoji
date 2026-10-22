/**
 * The grade settings remap (E17): scoped to the gate's classroom, the body
 * validated, refusals returned as data, and an audit row naming the surface
 * with what was rewritten (repo grades, quiz adjustments, request snapshots).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  remapGradeEmojis: vi.fn(),
  replaceScale: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignmentGrade: { remapGradeEmojis: (...a: unknown[]) => mocks.remapGradeEmojis(...a) },
    emojiMapping: { replaceScale: (...a: unknown[]) => mocks.replaceScale(...a) },
  },
}));

const { action } = await import('../action');
const { DEFAULT_EMOJI_MAPPINGS, SCORE_EMOJI_MAPPINGS } = await import('@classmoji/utils');

const post = (name: string, body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request(`http://localhost/admin/cs52/settings/grades?/${name}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Record<string, unknown>>;

class RemapGradeEmojisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemapGradeEmojisError';
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomAdmin.mockResolvedValue({
    classroom: { id: 'class-x', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
    userId: 'owner-1',
  });
  mocks.remapGradeEmojis.mockResolvedValue({
    totalRemapped: 3,
    repoGrades: 2,
    quizAdjustments: 1,
    regradeSnapshots: 1,
  });
});

describe('remapOrphanedEmojis', () => {
  it("remaps in the gate's classroom, never one from the body, and audits it", async () => {
    const result = await post('remapOrphanedEmojis', {
      classroomId: 'class-y',
      mappings: [{ oldEmoji: '+1', newEmoji: 'score-90', extra: 'ignored' }],
    });

    expect(mocks.remapGradeEmojis).toHaveBeenCalledWith('class-x', [
      { oldEmoji: '+1', newEmoji: 'score-90' },
    ]);
    expect(result).toMatchObject({
      action: 'REMAP_ORPHANED_EMOJIS',
      success: 'Remapped 2 grade(s) and 1 quiz adjustment(s).',
      totalRemapped: 3,
    });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith({
      classroomId: 'class-x',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'UPDATE',
      resourceType: 'GRADES',
      metadata: {
        tool: 'web:settings.grades.remap_orphaned_emojis',
        mappings: [{ old_emoji: '+1', new_emoji: 'score-90' }],
        repo_grades: 2,
        quiz_adjustments: 1,
        regrade_snapshots: 1,
      },
      dedupe: false,
    });
  });

  it.each([
    ['no mappings', {}],
    ['an empty list', { mappings: [] }],
    ['a non-string emoji', { mappings: [{ oldEmoji: '+1', newEmoji: 7 }] }],
    ['an empty emoji', { mappings: [{ oldEmoji: '', newEmoji: 'score-90' }] }],
  ])('refuses %s without writing or auditing', async (_label, body) => {
    const result = await post('remapOrphanedEmojis', body);
    expect(result.error).toBeTruthy();
    expect(mocks.remapGradeEmojis).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it("returns the service's refusal as data and audits nothing", async () => {
    mocks.remapGradeEmojis.mockRejectedValue(
      new RemapGradeEmojisError(":rocket: is not on this classroom's scale.")
    );
    const result = await post('remapOrphanedEmojis', {
      mappings: [{ oldEmoji: '+1', newEmoji: 'rocket' }],
    });
    expect(result).toEqual({
      action: 'REMAP_ORPHANED_EMOJIS',
      error: ":rocket: is not on this classroom's scale.",
    });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('populate', () => {
  it('replaces the scale in one call (no delete/save loop a re-seed could interleave)', async () => {
    await post('populateDefaultMappings', {});
    expect(mocks.replaceScale).toHaveBeenCalledWith('class-x', DEFAULT_EMOJI_MAPPINGS);
    await post('populateScoreScaleMappings', {});
    expect(mocks.replaceScale).toHaveBeenCalledWith('class-x', SCORE_EMOJI_MAPPINGS);
  });
});
