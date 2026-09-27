/**
 * The staff Modules page in a classroom that does not show quizzes (not Pro,
 * or switched off): no quiz row, candidate or binding leaves the loader, the
 * action refuses to add a quiz item, and a reorder or move still works in a
 * module that holds quiz rows the page never saw — the services take a
 * module's FULL list, so the action puts each hidden row back after the row it
 * follows now. A module that owns hidden quiz assignments cannot be deleted,
 * whatever else it lists; the loader flags it (a boolean, nothing else) so the
 * page offers no Delete, and a delete posted from a stale page gets a line
 * naming nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  listModuleContentsForClassroom: vi.fn(),
  listModuleContents: vi.fn(),
  getCandidateContent: vi.fn(),
  assignmentListForClassroom: vi.fn(),
  repositoryFindByClassroomId: vi.fn(),
  tagFindByClassroomId: vi.fn(),
  addItem: vi.fn(),
  reorderItems: vi.fn(),
  moveItemToModule: vi.fn(),
  reorderInModule: vi.fn(),
  moveToModule: vi.fn(),
  deleteById: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
}));
vi.mock('~/utils/helpers', () => ({ assertClassroomMutationAllowed: vi.fn() }));
vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: {
      listModuleContentsForClassroom: (...a: unknown[]) =>
        mocks.listModuleContentsForClassroom(...a),
      listModuleContents: (...a: unknown[]) => mocks.listModuleContents(...a),
      getCandidateContent: (...a: unknown[]) => mocks.getCandidateContent(...a),
      addItem: (...a: unknown[]) => mocks.addItem(...a),
      reorderItems: (...a: unknown[]) => mocks.reorderItems(...a),
      moveItemToModule: (...a: unknown[]) => mocks.moveItemToModule(...a),
      deleteById: (...a: unknown[]) => mocks.deleteById(...a),
    },
    assignment: {
      listForClassroom: (...a: unknown[]) => mocks.assignmentListForClassroom(...a),
      reorderInModule: (...a: unknown[]) => mocks.reorderInModule(...a),
      moveToModule: (...a: unknown[]) => mocks.moveToModule(...a),
    },
    repository: {
      findByClassroomId: (...a: unknown[]) => mocks.repositoryFindByClassroomId(...a),
    },
    organizationTag: { findByClassroomId: (...a: unknown[]) => mocks.tagFindByClassroomId(...a) },
  },
}));

// The page component is not under test; keep antd and the card tree out.
vi.mock('~/components', () => ({
  SearchInput: () => null,
  ButtonNew: () => null,
  RequireRole: () => null,
}));
vi.mock('~/hooks', () => ({ useDragReorder: vi.fn(), dragRowClass: vi.fn() }));
vi.mock('~/components/features/modules/ModuleCard', () => ({ default: () => null }));
vi.mock('~/components/features/modules/useCourseworkDrag', () => ({ useCourseworkDrag: vi.fn() }));
vi.mock('../ModuleFormModal', () => ({ default: () => null }));

const { loader, action } = await import('../route');
const { withHiddenRows } = await import('../quizRows.server');

const CLASSROOM_ID = 'class-1';

const moduleRow = () => ({
  id: 'mod-1',
  title: 'Week 1',
  items: [
    { id: 'item-page', item_type: 'PAGE', page: { id: 'p1', title: 'Intro', is_draft: false } },
    {
      id: 'item-quiz',
      item_type: 'QUIZ',
      quiz: { id: 'q1', name: 'Recursion', status: 'PUBLISHED' },
    },
    { id: 'item-slide', item_type: 'SLIDE', slide: { id: 's1', title: 'Deck', is_draft: false } },
  ],
  assignments: [
    { id: 'asg-repo', type: 'REPO', title: 'Lab 1' },
    { id: 'asg-quiz', type: 'QUIZ', title: 'Quiz 1', quiz: { id: 'q1', name: 'Recursion' } },
    { id: 'asg-form', type: 'FORM', title: 'Survey' },
  ],
});

// A module whose only assignment is a quiz one: without quizzes the page lists
// no assignment for it, yet the service refuses to delete it.
const quizOnlyModule = () => ({
  id: 'mod-2',
  title: 'Week 2',
  items: [{ id: 'item-page-2', item_type: 'PAGE', page: { id: 'p2', title: 'Notes' } }],
  assignments: [
    { id: 'asg-quiz-2', type: 'QUIZ', title: 'Quiz 2', quiz: { id: 'q2', name: 'Closures' } },
  ],
});

const emptyModule = () => ({ id: 'mod-3', title: 'Week 3', items: [], assignments: [] });

// A module the page lists every assignment of: nothing of it is hidden.
const listedModule = () => ({
  id: 'mod-4',
  title: 'Week 4',
  items: [],
  assignments: [
    { id: 'asg-repo-4', type: 'REPO', title: 'Lab 4' },
    { id: 'asg-form-4', type: 'FORM', title: 'Survey 4' },
  ],
});

const load = () =>
  loader({
    params: { class: 'cs52' },
    request: new Request('http://x/admin/cs52/modules'),
  } as never);

const post = (name: string, body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request(`http://x/admin/cs52/modules?/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<{ success?: string; error?: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomAdmin.mockResolvedValue({
    classroom: { id: CLASSROOM_ID, status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.listModuleContentsForClassroom.mockResolvedValue([moduleRow()]);
  mocks.listModuleContents.mockResolvedValue(moduleRow());
  mocks.getCandidateContent.mockResolvedValue({
    pages: [{ id: 'p1', title: 'Intro', is_draft: false }],
    slides: [],
    quizzes: [{ id: 'q1', name: 'Recursion', status: 'PUBLISHED' }],
    forms: [],
  });
  mocks.assignmentListForClassroom.mockResolvedValue([
    { id: 'asg-quiz', quiz_id: 'q1', form_id: null },
    { id: 'asg-form', quiz_id: null, form_id: 'f1' },
  ]);
  mocks.repositoryFindByClassroomId.mockResolvedValue([]);
  mocks.tagFindByClassroomId.mockResolvedValue([]);
  for (const m of [
    mocks.addItem,
    mocks.reorderItems,
    mocks.moveItemToModule,
    mocks.reorderInModule,
    mocks.moveToModule,
  ]) {
    m.mockResolvedValue(undefined);
  }
});

describe('Modules loader', () => {
  it('sends no quiz items, quiz assignments, quiz candidates or quiz bindings without quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    const result = await load();

    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith(CLASSROOM_ID);
    expect(result.quizzesVisible).toBe(false);
    expect(result.modules[0].items.map(i => i.id)).toEqual(['item-page', 'item-slide']);
    expect(result.modules[0].assignments.map(a => a.id)).toEqual(['asg-repo', 'asg-form']);
    expect(result.candidates.quizzes).toEqual([]);
    expect(result.candidates.pages).toHaveLength(1);
    expect(result.boundQuizIds).toEqual([]);
    expect(result.boundFormIds).toEqual(['f1']);
    expect(JSON.stringify(result)).not.toMatch(/Recursion|Quiz 1/);
  });

  it('keeps every quiz row when the classroom shows quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(true);
    const result = await load();

    expect(result.quizzesVisible).toBe(true);
    expect(result.modules[0].items.map(i => i.id)).toEqual([
      'item-page',
      'item-quiz',
      'item-slide',
    ]);
    expect(result.modules[0].assignments.map(a => a.id)).toEqual([
      'asg-repo',
      'asg-quiz',
      'asg-form',
    ]);
    expect(result.candidates.quizzes).toHaveLength(1);
    expect(result.boundQuizIds).toEqual(['q1']);
  });

  it('flags every module that owns a hidden assignment, and sends nothing else about them', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContentsForClassroom.mockResolvedValue([
      moduleRow(),
      quizOnlyModule(),
      emptyModule(),
      listedModule(),
    ]);
    const result = await load();

    expect(result.modules.map(m => [m.id, m.hasUnlistedAssignments])).toEqual([
      ['mod-1', true], // lists its repo and form assignments, owns a quiz one too
      ['mod-2', true], // lists none, owns a quiz one
      ['mod-3', false], // owns none
      ['mod-4', false], // lists every one it owns
    ]);
    expect(result.modules[0].assignments.map(a => a.id)).toEqual(['asg-repo', 'asg-form']);
    expect(result.modules[1].assignments).toEqual([]);
    expect(result.modules[1].items.map(i => i.id)).toEqual(['item-page-2']);
    expect(JSON.stringify(result)).not.toMatch(/Closures|Quiz 2|asg-quiz|"q2"/);
    // A boolean and nothing else: no count of what is hidden.
    expect(typeof result.modules[0].hasUnlistedAssignments).toBe('boolean');
  });

  it('flags nothing when the classroom shows quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(true);
    mocks.listModuleContentsForClassroom.mockResolvedValue([
      moduleRow(),
      quizOnlyModule(),
      emptyModule(),
    ]);
    const result = await load();

    expect(result.modules.map(m => m.hasUnlistedAssignments)).toEqual([false, false, false]);
    expect(result.modules[1].assignments.map(a => a.id)).toEqual(['asg-quiz-2']);
  });
});

describe('Modules action — delete', () => {
  const MOVE_FIRST = 'Move or delete this module’s assignments first.';
  const CANT_DELETE = 'This module can’t be deleted.';
  const refuse = () =>
    mocks.deleteById.mockRejectedValue(new Error('Module still has assignments'));

  it('deletes a module the service lets go', async () => {
    mocks.deleteById.mockResolvedValue({ id: 'mod-3' });
    const result = await post('delete', { id: 'mod-3' });

    expect(result).toEqual({ success: 'Module deleted' });
    expect(mocks.deleteById).toHaveBeenCalledWith('mod-3', CLASSROOM_ID);
  });

  it('answers a stale delete blocked only by hidden assignments with a line naming none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContents.mockResolvedValue(quizOnlyModule());
    refuse();
    const result = await post('delete', { id: 'mod-2' });

    expect(result).toEqual({ error: CANT_DELETE });
    expect(JSON.stringify(result)).not.toMatch(/quiz|assignment|hidden/i);
    expect(mocks.listModuleContents).toHaveBeenCalledWith('mod-2', CLASSROOM_ID);
    // The refused delete was the only write attempted.
    expect(mocks.deleteById).toHaveBeenCalledTimes(1);
    for (const write of [
      mocks.addItem,
      mocks.reorderItems,
      mocks.moveItemToModule,
      mocks.reorderInModule,
      mocks.moveToModule,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('answers a module that lists some assignments but owns hidden ones with the same line', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContents.mockResolvedValue(moduleRow());
    refuse();

    // Moving the listed ones would not unblock it, so the line does not ask to.
    expect(await post('delete', { id: 'mod-1' })).toEqual({ error: CANT_DELETE });
  });

  it('keeps the move-first line when the page lists every assignment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContents.mockResolvedValue(listedModule());
    refuse();

    expect(await post('delete', { id: 'mod-4' })).toEqual({ error: MOVE_FIRST });
  });

  it('keeps the move-first line when the classroom shows quizzes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.loadQuizzesVisible.mockResolvedValue(true);
    refuse();

    expect(await post('delete', { id: 'mod-2' })).toEqual({ error: MOVE_FIRST });
    expect(mocks.listModuleContents).not.toHaveBeenCalled();
  });

  it('falls back to the generic line when looking the module up fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContents.mockRejectedValue(new Error('connection reset'));
    refuse();

    expect(await post('delete', { id: 'mod-2' })).toEqual({
      error: 'Failed to delete module. Please try again.',
    });
  });

  it('answers any other failure with the generic line', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.deleteById.mockRejectedValue(new Error('Module not found in classroom'));

    expect(await post('delete', { id: 'mod-x' })).toEqual({
      error: 'Failed to delete module. Please try again.',
    });
    expect(mocks.loadQuizzesVisible).not.toHaveBeenCalled();
  });
});

describe('Modules action — addItem', () => {
  it('refuses a quiz item without quizzes, and writes nothing', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    const result = await post('addItem', { moduleId: 'mod-1', itemType: 'QUIZ', targetId: 'q1' });

    expect(result).toEqual({ error: "Quizzes aren't available in this class." });
    expect(mocks.addItem).not.toHaveBeenCalled();
  });

  it('adds a quiz item when the classroom shows quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(true);
    const result = await post('addItem', { moduleId: 'mod-1', itemType: 'QUIZ', targetId: 'q1' });

    expect(result.success).toBeDefined();
    expect(mocks.addItem).toHaveBeenCalledWith('mod-1', 'QUIZ', 'q1', CLASSROOM_ID);
  });

  it('still adds other kinds without quizzes', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    const result = await post('addItem', { moduleId: 'mod-1', itemType: 'PAGE', targetId: 'p1' });

    expect(result.success).toBeDefined();
    expect(mocks.addItem).toHaveBeenCalledWith('mod-1', 'PAGE', 'p1', CLASSROOM_ID);
  });
});

describe('Modules action — ordering around hidden quiz rows', () => {
  it('reorderItems puts the hidden quiz item back after the item it follows', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    // The page saw [page, slide] and swapped them; the quiz follows the page.
    const result = await post('reorderItems', {
      moduleId: 'mod-1',
      orderedItemIds: ['item-slide', 'item-page'],
    });

    expect(result.success).toBeDefined();
    expect(mocks.listModuleContents).toHaveBeenCalledWith('mod-1', CLASSROOM_ID);
    expect(mocks.reorderItems).toHaveBeenCalledWith(
      'mod-1',
      ['item-slide', 'item-page', 'item-quiz'],
      CLASSROOM_ID
    );
  });

  it('reorderItems passes the page order through when quizzes show', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(true);
    const ordered = ['item-slide', 'item-quiz', 'item-page'];
    await post('reorderItems', { moduleId: 'mod-1', orderedItemIds: ordered });

    expect(mocks.listModuleContents).not.toHaveBeenCalled();
    expect(mocks.reorderItems).toHaveBeenCalledWith('mod-1', ordered, CLASSROOM_ID);
  });

  it('moveItem keeps the TARGET module’s hidden quiz item', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    // A page from another module dropped between the target's page and slide.
    await post('moveItem', {
      moduleItemId: 'item-other',
      toModuleId: 'mod-1',
      orderedItemIds: ['item-page', 'item-other', 'item-slide'],
    });

    expect(mocks.listModuleContents).toHaveBeenCalledWith('mod-1', CLASSROOM_ID);
    expect(mocks.moveItemToModule).toHaveBeenCalledWith(
      'item-other',
      'mod-1',
      ['item-page', 'item-quiz', 'item-other', 'item-slide'],
      CLASSROOM_ID
    );
  });

  it('reorderAssignments puts the hidden quiz assignment back after the one it follows', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    await post('reorderAssignments', {
      moduleId: 'mod-1',
      orderedAssignmentIds: ['asg-form', 'asg-repo'],
    });

    expect(mocks.reorderInModule).toHaveBeenCalledWith(
      'mod-1',
      ['asg-form', 'asg-repo', 'asg-quiz'],
      CLASSROOM_ID
    );
  });

  it('moveAssignment keeps the TARGET module’s hidden quiz assignment', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    await post('moveAssignment', {
      assignmentId: 'asg-other',
      toModuleId: 'mod-1',
      orderedAssignmentIds: ['asg-repo', 'asg-form', 'asg-other'],
    });

    expect(mocks.moveToModule).toHaveBeenCalledWith(
      'asg-other',
      'mod-1',
      ['asg-repo', 'asg-quiz', 'asg-form', 'asg-other'],
      CLASSROOM_ID
    );
  });

  it('moveAssignment keeps a trailing hidden quiz last when a row lands above it', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);
    mocks.listModuleContents.mockResolvedValue({
      ...moduleRow(),
      assignments: [
        { id: 'asg-repo', type: 'REPO', title: 'Lab 1' },
        { id: 'asg-form', type: 'FORM', title: 'Survey' },
        { id: 'asg-quiz', type: 'QUIZ', title: 'Quiz 1' },
      ],
    });
    // Dropped at the top of the target: every visible row shifts down one.
    await post('moveAssignment', {
      assignmentId: 'asg-other',
      toModuleId: 'mod-1',
      orderedAssignmentIds: ['asg-other', 'asg-repo', 'asg-form'],
    });

    expect(mocks.moveToModule).toHaveBeenCalledWith(
      'asg-other',
      'mod-1',
      ['asg-other', 'asg-repo', 'asg-form', 'asg-quiz'],
      CLASSROOM_ID
    );
  });
});

describe('withHiddenRows', () => {
  const rows = (spec: string) =>
    spec.split(' ').map(s => ({ id: s.replace('*', ''), hidden: s.endsWith('*') }));

  it('returns the order unchanged when nothing is hidden', () => {
    expect(withHiddenRows(rows('a b c'), ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('keeps each hidden row after the row it follows, and a leading one at the front', () => {
    expect(withHiddenRows(rows('q1* a b q2*'), ['b', 'a'])).toEqual(['q1', 'b', 'q2', 'a']);
  });

  it('does not drift when a row is inserted above a trailing hidden row', () => {
    // By index, q would land at 2 and split a from b.
    expect(withHiddenRows(rows('a b q*'), ['m', 'a', 'b'])).toEqual(['m', 'a', 'b', 'q']);
  });

  it('keeps hidden rows that share an anchor in their current order', () => {
    expect(withHiddenRows(rows('a q1* q2* b'), ['b', 'a'])).toEqual(['b', 'a', 'q1', 'q2']);
  });

  it('anchors past a visible row the page left out, and does not add that row back', () => {
    // b is missing from the list; the service refuses it, as it would anyway.
    expect(withHiddenRows(rows('a b q* c'), ['c', 'a'])).toEqual(['c', 'a', 'q']);
  });

  it('leaves a hidden row the page did name where the page put it', () => {
    expect(withHiddenRows(rows('a q* b'), ['q', 'b', 'a'])).toEqual(['q', 'b', 'a']);
  });
});
