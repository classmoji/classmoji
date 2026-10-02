/**
 * Pins the assignments on the modules read (the `modules` resource and its
 * `list_modules` mirror, which share one handler).
 *
 * An assignment belongs to exactly one module (`Assignment.module_id`), and
 * this read is the only place that says which. So every module carries its
 * `assignments` beside its content `items`:
 *
 *   - in the order the service hands them over (the display order);
 *   - each reduced to an allowlist, with one generic target pair in place of
 *     three nullable id columns;
 *   - filtered for students by the service (`includeUnpublished` follows the
 *     role), with `is_published` on a staff payload only;
 *   - without quiz assignments where the classroom shows no quizzes, for every
 *     role, exactly as quiz items are;
 *   - and without the legacy REPOSITORY item rows no web screen renders.
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
    expect(form).toMatchObject({
      type: 'FORM',
      target_id: 'f1',
      target_title: 'Team prefs form',
      is_extra_credit: true,
    });
  });

  it('asks the service for drafts by role, and marks publication for staff only', async () => {
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT'] as const) {
      const payload = await read(role);
      expect(mocks.listForClassroom).toHaveBeenLastCalledWith('w26', { includeUnpublished: true });
      expect(payload.modules[0].assignments[0], role).toHaveProperty('is_published', true);
    }

    // The service drops a student's unpublished rows (and a REPO assignment
    // whose repository is unpublished); what is left is published by
    // definition, so the flag is not sent.
    mocks.listForClassroom.mockResolvedValue([{ ...MODULES[0], assignments: [LAB, FORM] }]);
    const payload = await read('STUDENT');
    expect(mocks.listForClassroom).toHaveBeenLastCalledWith('w26', { includeUnpublished: false });
    expect(assignmentIds(payload)).toEqual([['a-lab', 'a-form']]);
    for (const assignment of payload.modules[0].assignments) {
      expect(assignment).not.toHaveProperty('is_published');
    }
    expect(JSON.stringify(payload)).not.toContain('private staff notes');
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

  it('asks about quizzes when the only quiz row is an assignment', async () => {
    await read('OWNER');
    expect(mocks.quizzesVisible).toHaveBeenCalledTimes(1);
    expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');

    mocks.quizzesVisible.mockClear();
    mocks.listForClassroom.mockResolvedValue([{ ...MODULES[0], assignments: [LAB, FORM] }]);
    await read('OWNER');
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });

  it('drops legacy REPOSITORY items: a repository shows up through its assignment', async () => {
    const payload = await read('OWNER');
    expect(payload.modules[0].items.map(i => i.id)).toEqual(['i-page']);
    expect(payload.modules[0].assignments[0]).toMatchObject({ type: 'REPO', target_id: 'repo-1' });
  });

  it('reports a module that owns no assignments as an empty list', async () => {
    const { assignments: _omitted, ...bare } = MODULES[1];
    mocks.listForClassroom.mockResolvedValue([bare]);

    expect((await read('OWNER')).modules[0].assignments).toEqual([]);
  });
});
