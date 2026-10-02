/**
 * Pins the assignments on the modules read (the `modules` resource and its
 * `list_modules` mirror, which share one handler).
 *
 * An assignment belongs to exactly one module (`Assignment.module_id`), and
 * this read is the only place that says which. So every module carries its
 * `assignments` beside its content `items`:
 *
 *   - in the order the service hands them over (the display order);
 *   - for staff, reduced to an allowlist with one generic target pair in place
 *     of three nullable id columns;
 *   - for a student, reduced to what their module row renders — title, type
 *     and due date — and never the quiz or form behind the assignment, which
 *     the service's filter does not check and which may still be a draft;
 *   - filtered for students by the service (`includeUnpublished` follows the
 *     role);
 *   - without quiz assignments where the classroom shows no quizzes, for every
 *     role, exactly as quiz items are.
 *
 * Legacy REPOSITORY item rows are passed through as before: the public course
 * site still draws them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  listForClassroom: vi.fn(),
  quizzesVisible: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({ assertProTier: vi.fn() }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: { listForClassroom: (...a: unknown[]) => mocks.listForClassroom(...a) },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
  },
}));

const { modulesResource } = await import('../content.ts');

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

const ctxAs = (role: Role): ToolContext =>
  ({
    viewer: { userId: 'user-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { slug: 'w26', settings: {} },
    },
  }) as unknown as ToolContext;

const DEADLINE = new Date('2026-10-12T03:59:00.000Z');

/** Assignment rows as module.listForClassroom loads them (ASSIGNMENT_INCLUDE). */
const LAB = {
  id: 'a-lab',
  module_id: 'mod-1',
  title: 'Starterpack: Getting started with Vite',
  type: 'REPO',
  submission_mode: 'REPO',
  position: 0,
  weight: 100,
  is_extra_credit: false,
  is_published: true,
  student_deadline: DEADLINE,
  grader_deadline: DEADLINE,
  release_at: null,
  grades_released: false,
  description: 'private staff notes',
  repository_id: 'repo-1',
  quiz_id: null,
  form_id: null,
  repository: { id: 'repo-1', title: 'starterpack', slug: 'starterpack', is_published: true },
  quiz: null,
  form: null,
  pages: [],
  slides: [],
  _count: { git_repo_assignments: 27 },
};
const QUIZ = {
  ...LAB,
  id: 'a-quiz',
  title: 'React quiz',
  type: 'QUIZ',
  submission_mode: 'ISSUE',
  is_published: false,
  student_deadline: null,
  repository_id: null,
  quiz_id: 'q1',
  repository: null,
  quiz: { id: 'q1', name: 'React basics', status: 'DRAFT' },
};
const FORM = {
  ...LAB,
  id: 'a-form',
  title: 'Team preferences',
  type: 'FORM',
  submission_mode: 'ISSUE',
  is_extra_credit: true,
  repository_id: null,
  form_id: 'f1',
  repository: null,
  form: { id: 'f1', title: 'Team prefs form', slug: 'team-prefs', status: 'PUBLISHED' },
};

const MODULES = [
  {
    id: 'mod-1',
    classroom_id: 'class-1',
    title: 'Frameworks and Tooling',
    slug: 'frameworks-and-tooling',
    description: null,
    position: 0,
    is_published: true,
    items: [
      { id: 'i-page', item_type: 'PAGE', position: 0, page: { id: 'p1', title: 'Intro' } },
      {
        id: 'i-legacy',
        item_type: 'REPOSITORY',
        position: 1,
        repository: { id: 'repo-1', title: 'starterpack' },
      },
    ],
    assignments: [LAB, QUIZ, FORM],
  },
  {
    id: 'mod-2',
    classroom_id: 'class-1',
    title: 'starterpack',
    slug: 'starterpack',
    description: null,
    position: 1,
    is_published: false,
    items: [],
    assignments: [],
  },
];

interface AssignmentOut {
  id: string;
  type: string;
  [key: string]: unknown;
}
type Payload = {
  enabled: boolean;
  modules: Array<{ id: string; items: Array<{ id: string }>; assignments: AssignmentOut[] }>;
};

const URI = new URL('classmoji://org/w26/modules');

const read = async (role: Role) =>
  (await modulesResource.handler({ org: 'org', slug: 'w26' }, ctxAs(role), URI)) as Payload;

const assignmentIds = (payload: Payload) => payload.modules.map(m => m.assignments.map(a => a.id));

beforeEach(() => {
  mocks.listForClassroom.mockReset().mockResolvedValue(MODULES);
  mocks.quizzesVisible.mockReset().mockResolvedValue(true);
});

describe('modules read — assignments', () => {
  it('lists each module’s assignments in the order the service returns them', async () => {
    expect(assignmentIds(await read('OWNER'))).toEqual([['a-lab', 'a-quiz', 'a-form'], []]);
  });

  it('gives staff the placement fields and nothing else from the row', async () => {
    const [lab, quiz, form] = (await read('OWNER')).modules[0].assignments;

    expect(lab).toEqual({
      id: 'a-lab',
      title: 'Starterpack: Getting started with Vite',
      type: 'REPO',
      target_id: 'repo-1',
      target_title: 'starterpack',
      submission_mode: 'REPO',
      weight: 100,
      is_extra_credit: false,
      student_deadline: DEADLINE,
      is_published: true,
    });
    // A quiz or form assignment names its own target, and carries no
    // submission mode: that column is meaningful for REPO alone.
    expect(quiz).toEqual({
      id: 'a-quiz',
      title: 'React quiz',
      type: 'QUIZ',
      target_id: 'q1',
      target_title: 'React basics',
      weight: 100,
      is_extra_credit: false,
      student_deadline: null,
      is_published: false,
    });
    expect(form).toEqual({
      id: 'a-form',
      title: 'Team preferences',
      type: 'FORM',
      target_id: 'f1',
      target_title: 'Team prefs form',
      weight: 100,
      is_extra_credit: true,
      student_deadline: DEADLINE,
      is_published: true,
    });
  });

  it('asks the service for drafts by role: staff yes, a student no', async () => {
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT'] as const) {
      const payload = await read(role);
      expect(mocks.listForClassroom).toHaveBeenLastCalledWith('w26', {
        includeUnpublished: true,
        quizzesVisible: true,
      });
      expect(payload.modules[0].assignments[0], role).toHaveProperty('is_published', true);
    }

    // The service is what drops a student's unpublished rows (and a REPO
    // assignment whose repository is unpublished, a quiz not yet open, or a
    // form still a draft); this layer's part is to ask, with the classroom's
    // own answer on quizzes.
    await read('STUDENT');
    expect(mocks.listForClassroom).toHaveBeenLastCalledWith('w26', {
      includeUnpublished: false,
      quizzesVisible: true,
    });

    mocks.quizzesVisible.mockResolvedValue(false);
    await read('STUDENT');
    expect(mocks.listForClassroom).toHaveBeenLastCalledWith('w26', {
      includeUnpublished: false,
      quizzesVisible: false,
    });
  });

  it('gives a student exactly what their module row renders, never the target', async () => {
    // Rows whose targets are drafts: the service's student filter leaves such
    // rows out, but should one reach this layer, the student shape still
    // names no target.
    const publishedOnDraftQuiz = {
      ...QUIZ,
      is_published: true,
      student_deadline: DEADLINE,
      quiz: { id: 'q-draft', name: 'UNRELEASED midterm questions', status: 'DRAFT' },
    };
    const publishedOnDraftForm = {
      ...FORM,
      form: { id: 'f-draft', title: 'UNRELEASED team survey', slug: 'x', status: 'DRAFT' },
    };
    mocks.listForClassroom.mockResolvedValue([
      { ...MODULES[0], assignments: [LAB, publishedOnDraftQuiz, publishedOnDraftForm] },
    ]);

    const payload = await read('STUDENT');

    expect(payload.modules[0].assignments).toEqual([
      {
        id: 'a-lab',
        title: 'Starterpack: Getting started with Vite',
        type: 'REPO',
        student_deadline: DEADLINE,
      },
      { id: 'a-quiz', title: 'React quiz', type: 'QUIZ', student_deadline: DEADLINE },
      { id: 'a-form', title: 'Team preferences', type: 'FORM', student_deadline: DEADLINE },
    ]);
    const text = JSON.stringify(payload.modules[0].assignments);
    for (const leak of ['UNRELEASED', 'q-draft', 'f-draft', 'repo-1', 'private staff notes']) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('drops quiz assignments, and only those, for every role where quizzes are hidden', async () => {
    mocks.quizzesVisible.mockResolvedValue(false);

    for (const role of ['OWNER', 'STUDENT'] as const) {
      const payload = await read(role);
      expect(assignmentIds(payload), role).toEqual([['a-lab', 'a-form'], []]);
      // No key or value names one: this is why the target is a generic pair.
      expect(JSON.stringify(payload).toLowerCase(), role).not.toContain('quiz');
    }
  });

  it('asks about quizzes once per read, for the authorized classroom', async () => {
    await read('OWNER');
    expect(mocks.quizzesVisible).toHaveBeenCalledTimes(1);
    expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');
  });

  it('leaves the content items as they were, legacy REPOSITORY rows included', async () => {
    const payload = await read('OWNER');
    expect(payload.modules[0].items).toEqual([
      { id: 'i-page', type: 'PAGE', position: 0, target_id: 'p1', title: 'Intro' },
      {
        id: 'i-legacy',
        type: 'REPOSITORY',
        position: 1,
        target_id: 'repo-1',
        title: 'starterpack',
      },
    ]);
  });

  it('reports a module that owns no assignments as an empty list', async () => {
    const { assignments: _omitted, ...bare } = MODULES[1];
    mocks.listForClassroom.mockResolvedValue([bare]);

    expect((await read('OWNER')).modules[0].assignments).toEqual([]);
  });
});
