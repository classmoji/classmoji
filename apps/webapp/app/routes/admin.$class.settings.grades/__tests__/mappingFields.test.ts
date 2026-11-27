/**
 * The emoji and letter grade intents of the grades settings action write only
 * the fields the settings table sends, to the URL's classroom, and audit each
 * change. A body field naming a classroom or a row id is not read.
 *
 * The services' own rule (the classroom and the row are never taken from the
 * values) runs against Postgres in packages/services
 * (classmoji/__tests__/gradeMappings.integration.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  saveEmojiMapping: vi.fn(),
  deleteEmojiMapping: vi.fn(),
  saveLetterGrade: vi.fn(),
  deleteLetterGrade: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

const { fromServicesFake } = await vi.hoisted(() => import('~/__tests__/support/servicesFake.ts'));
vi.mock('@classmoji/services/audit', () => fromServicesFake('audit'));
vi.mock('@classmoji/services/auth-email', () => fromServicesFake('authEmail'));
vi.mock('@classmoji/services/classroom', () => fromServicesFake('classroom'));
vi.mock('@classmoji/services/classroom-membership', () => fromServicesFake('classroomMembership'));
vi.mock('@classmoji/services/github-user-token', () => fromServicesFake('githubUserToken'));
vi.mock('@classmoji/services/subscription', () => fromServicesFake('subscription'));
vi.mock('@classmoji/services/gitlab-instance', () => fromServicesFake('gitlabInstance'));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    emojiMapping: {
      saveEmojiMapping: (...a: unknown[]) => mocks.saveEmojiMapping(...a),
      deleteEmojiMapping: (...a: unknown[]) => mocks.deleteEmojiMapping(...a),
    },
    letterGradeMapping: {
      save: (...a: unknown[]) => mocks.saveLetterGrade(...a),
      delete: (...a: unknown[]) => mocks.deleteLetterGrade(...a),
    },
    audit: {
      create: (...a: unknown[]) => mocks.auditCreate(...a),
      record: (row: unknown) =>
        import('../../../__tests__/support/auditRecord.ts').then(m =>
          m.recordThrough(r => mocks.auditCreate(r))(row)
        ),
    },
  },
}));

vi.mock('~/routes/admin.$class.ask-moji/impersonation.server', () => ({
  impersonationAuditFields: async () => ({}),
}));

const { action } = await import('../action');

const post = (intent: string, body: unknown) =>
  action({
    params: { class: 'class-x' },
    request: new Request(`http://localhost/admin/class-x/settings/grades?/${intent}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-x',
    classroom: { id: 'class-x', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.saveEmojiMapping.mockResolvedValue({ id: 'em-1' });
  mocks.saveLetterGrade.mockResolvedValue({ id: 'lg-1' });
  mocks.deleteEmojiMapping.mockResolvedValue({ count: 1 });
  mocks.deleteLetterGrade.mockResolvedValue({ count: 1 });
  mocks.auditCreate.mockResolvedValue(null);
});

describe('saveEmojiToGradeMapping', () => {
  it("passes only the row's fields, for the URL's classroom, and audits the change", async () => {
    await post('saveEmojiToGradeMapping', {
      emoji: 'star',
      grade: 90,
      extra_tokens: 2,
      description: 'Great',
      classroom_id: 'class-y',
      id: 'row-of-class-y',
    });

    expect(mocks.saveEmojiMapping).toHaveBeenCalledWith('class-x', {
      emoji: 'star',
      grade: 90,
      extra_tokens: 2,
      description: 'Great',
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      classroom_id: 'class-x',
      action: 'UPDATE',
      resource_type: 'SETTINGS',
      resource_id: 'em-1',
      data: { tool: 'web:settings.grades.emoji_mapping_upsert', emoji: 'star', grade: 90 },
    });
  });

  it('refuses a row without an emoji or a numeric grade, writing nothing', async () => {
    for (const body of [{ grade: 90 }, { emoji: 'star', grade: '90' }, { emoji: '', grade: 1 }]) {
      expect(await post('saveEmojiToGradeMapping', body)).toMatchObject({
        error: expect.any(String),
      });
    }
    expect(mocks.saveEmojiMapping).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('deletes by emoji in the URL classroom and audits only a delete that happened', async () => {
    await post('deleteEmojiToGradeMapping', { emoji: 'star', classroom_id: 'class-y' });
    expect(mocks.deleteEmojiMapping).toHaveBeenCalledWith('class-x', 'star');
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);

    mocks.deleteEmojiMapping.mockResolvedValue({ count: 0 });
    mocks.auditCreate.mockClear();
    await post('deleteEmojiToGradeMapping', { emoji: 'nope' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('saveLetterGradeMapping', () => {
  it("passes only the letter and minimum, for the URL's classroom, and audits the change", async () => {
    await post('saveLetterGradeMapping', {
      letter_grade: 'A',
      min_grade: 90,
      classroom_id: 'class-y',
      id: 'row-of-class-y',
    });

    expect(mocks.saveLetterGrade).toHaveBeenCalledWith('class-x', {
      letter_grade: 'A',
      min_grade: 90,
    });
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      classroom_id: 'class-x',
      action: 'UPDATE',
      data: { tool: 'web:settings.grades.letter_grade_mapping_upsert', letter_grade: 'A' },
    });
  });

  it('refuses a malformed row, writing nothing', async () => {
    expect(await post('saveLetterGradeMapping', { letter_grade: 'A' })).toMatchObject({
      error: expect.any(String),
    });
    expect(mocks.saveLetterGrade).not.toHaveBeenCalled();
  });
});
