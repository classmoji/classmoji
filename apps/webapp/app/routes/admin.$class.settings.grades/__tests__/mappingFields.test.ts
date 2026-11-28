/**
 * The emoji and letter grade intents of the grades settings action write only
 * the fields the settings table sends, to the URL's classroom, and pass the
 * services the actor that records each change; the route writes no row of its
 * own. A body field naming a classroom or a row id is not read.
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
  requestImpersonator: vi.fn(),
}));

vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
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
  mocks.saveEmojiMapping.mockResolvedValue({ mapping: { id: 'em-1' }, audit: WRITTEN });
  mocks.saveLetterGrade.mockResolvedValue({ mapping: { id: 'lg-1' }, audit: WRITTEN });
  mocks.deleteEmojiMapping.mockResolvedValue({ count: 1, audit: WRITTEN });
  mocks.deleteLetterGrade.mockResolvedValue({ count: 1, audit: WRITTEN });
  mocks.auditCreate.mockResolvedValue(null);
  mocks.requestImpersonator.mockResolvedValue(null);
});

const WRITTEN = { written: 1, missed: 0 };
const actor = (tool: string, impersonatedBy: string | null = null) => ({
  userId: 'owner-x',
  role: 'OWNER',
  tool,
  impersonatedBy,
});

describe('saveEmojiToGradeMapping', () => {
  it("passes only the row's fields and the actor, for the URL's classroom", async () => {
    const result = await post('saveEmojiToGradeMapping', {
      emoji: 'star',
      grade: 90,
      extra_tokens: 2,
      description: 'Great',
      classroom_id: 'class-y',
      id: 'row-of-class-y',
    });

    expect(mocks.saveEmojiMapping).toHaveBeenCalledWith(
      'class-x',
      { emoji: 'star', grade: 90, extra_tokens: 2, description: 'Great' },
      actor('web:settings.grades.emoji_mapping_upsert')
    );
    // The mapping, as before; the service wrote the row.
    expect(result).toEqual({ id: 'em-1' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('passes the admin viewing as the owner, and answers the same when the row was missed', async () => {
    mocks.requestImpersonator.mockResolvedValue('admin-2');
    mocks.saveEmojiMapping.mockResolvedValue({
      mapping: { id: 'em-1' },
      audit: { written: 0, missed: 1 },
    });
    const result = await post('saveEmojiToGradeMapping', { emoji: 'star', grade: 90 });
    expect(mocks.saveEmojiMapping.mock.calls[0][2]).toEqual(
      actor('web:settings.grades.emoji_mapping_upsert', 'admin-2')
    );
    expect(result).toEqual({ id: 'em-1' });
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

  it('deletes by emoji in the URL classroom, with the actor that records it', async () => {
    const result = await post('deleteEmojiToGradeMapping', {
      emoji: 'star',
      classroom_id: 'class-y',
    });
    expect(mocks.deleteEmojiMapping).toHaveBeenCalledWith(
      'class-x',
      'star',
      actor('web:settings.grades.emoji_mapping_delete')
    );
    expect(result).toEqual({ deleted: 1 });

    mocks.deleteEmojiMapping.mockResolvedValue({ count: 0, audit: { written: 0, missed: 0 } });
    expect(await post('deleteEmojiToGradeMapping', { emoji: 'nope' })).toEqual({ deleted: 0 });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('saveLetterGradeMapping', () => {
  it("passes only the letter, the minimum and the actor, for the URL's classroom", async () => {
    const result = await post('saveLetterGradeMapping', {
      letter_grade: 'A',
      min_grade: 90,
      classroom_id: 'class-y',
      id: 'row-of-class-y',
    });

    expect(mocks.saveLetterGrade).toHaveBeenCalledWith(
      'class-x',
      { letter_grade: 'A', min_grade: 90 },
      actor('web:settings.grades.letter_grade_mapping_upsert')
    );
    expect(result).toEqual({ id: 'lg-1' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('deletes a letter in the URL classroom, with the actor that records it', async () => {
    const result = await post('deleteLetterGradeMapping', { letter_grade: 'A' });
    expect(mocks.deleteLetterGrade).toHaveBeenCalledWith(
      'class-x',
      'A',
      actor('web:settings.grades.letter_grade_mapping_delete')
    );
    expect(result).toEqual({ success: 'Deleted mapping successfully.' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a malformed row, writing nothing', async () => {
    expect(await post('saveLetterGradeMapping', { letter_grade: 'A' })).toMatchObject({
      error: expect.any(String),
    });
    expect(mocks.saveLetterGrade).not.toHaveBeenCalled();
  });
});
