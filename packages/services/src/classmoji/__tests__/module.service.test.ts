import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomFindUnique = vi.fn();
const moduleFindMany = vi.fn();
const moduleFindFirst = vi.fn();
const moduleFindUnique = vi.fn();
const moduleUpdate = vi.fn();
const moduleDelete = vi.fn();
const itemFindFirst = vi.fn();
const itemFindMany = vi.fn();
const itemCreate = vi.fn();
const itemUpdate = vi.fn();
const itemDeleteMany = vi.fn();
const assignmentFindMany = vi.fn();
const assignmentDeleteMany = vi.fn();
const queryRaw = vi.fn();
const transaction = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: classroomFindUnique },
    module: {
      findMany: moduleFindMany,
      findFirst: moduleFindFirst,
      findUnique: moduleFindUnique,
      update: moduleUpdate,
      delete: moduleDelete,
    },
    moduleItem: {
      findFirst: itemFindFirst,
      findMany: itemFindMany,
      create: itemCreate,
      update: itemUpdate,
      deleteMany: itemDeleteMany,
    },
    $transaction: transaction,
  }),
}));

vi.mock('@classmoji/utils', async () => ({
  titleToIdentifier: (s: string) => s.toLowerCase(),
  // The real rule: the student view's assignment filter is under test below.
  openToStudents: (await import('../../../../utils/src/assignmentVisibility.ts')).openToStudents,
}));

const {
  isItemPublished,
  isItemPubliclyVisible,
  setPublic,
  addItem,
  reorderItems,
  listForClassroom,
  deleteById,
} = await import('../module.service.ts');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isItemPublished', () => {
  it('hides a draft page and shows a published one', () => {
    expect(isItemPublished({ item_type: 'PAGE', page: { is_draft: true } } as never)).toBe(false);
    expect(isItemPublished({ item_type: 'PAGE', page: { is_draft: false } } as never)).toBe(true);
  });

  it('shows a repository only when it is published', () => {
    expect(
      isItemPublished({ item_type: 'REPOSITORY', repository: { is_published: false } } as never)
    ).toBe(false);
    expect(
      isItemPublished({ item_type: 'REPOSITORY', repository: { is_published: true } } as never)
    ).toBe(true);
  });

  it('hides a DRAFT quiz and shows a non-draft one', () => {
    expect(isItemPublished({ item_type: 'QUIZ', quiz: { status: 'DRAFT' } } as never)).toBe(false);
    expect(isItemPublished({ item_type: 'QUIZ', quiz: { status: 'PUBLISHED' } } as never)).toBe(
      true
    );
  });

  it('hides a DRAFT form but keeps an OPEN or CLOSED one', () => {
    const form = (status: string) =>
      isItemPublished({ item_type: 'FORM', form: { status, access: 'CLASSROOM' } } as never);
    expect(form('DRAFT')).toBe(false);
    expect(form('OPEN')).toBe(true);
    // CLOSED stays visible on purpose: students should still see the thing they
    // were asked to fill in, reading honestly as "Closed". Only DRAFT — never
    // published, no revision to render — is hidden.
    expect(form('CLOSED')).toBe(true);
  });

  it('hides an item whose target is missing', () => {
    expect(isItemPublished({ item_type: 'SLIDE', slide: null } as never)).toBe(false);
    expect(isItemPublished({ item_type: 'FORM', form: null } as never)).toBe(false);
  });
});

describe('isItemPubliclyVisible', () => {
  it('requires is_public on top of published, for pages and slides alike', () => {
    // Published-to-students is not published-to-the-web.
    const page = (is_draft: boolean, is_public: boolean) =>
      isItemPubliclyVisible({ item_type: 'PAGE', page: { is_draft, is_public } } as never);
    expect(page(false, true)).toBe(true);
    expect(page(false, false)).toBe(false);
    expect(page(true, true)).toBe(false);

    const slide = (is_draft: boolean, is_public: boolean) =>
      isItemPubliclyVisible({ item_type: 'SLIDE', slide: { is_draft, is_public } } as never);
    expect(slide(false, true)).toBe(true);
    expect(slide(false, false)).toBe(false);
    expect(slide(true, true)).toBe(false);
  });

  it('never shows a repository or a quiz, however published', () => {
    // Dropped entirely rather than rendered locked — the title alone leaks the
    // assignment before the course wants it public.
    expect(
      isItemPubliclyVisible({
        item_type: 'REPOSITORY',
        repository: { is_published: true },
      } as never)
    ).toBe(false);
    expect(
      isItemPubliclyVisible({ item_type: 'QUIZ', quiz: { status: 'PUBLISHED' } } as never)
    ).toBe(false);
  });

  it('requires access PUBLIC on top of non-draft, for a form', () => {
    // `access` is a form's `is_public`: a PUBLIC form is already a link anyone
    // may open and fill without signing in, so naming it on the public site
    // publishes nothing new. A CLASSROOM form is members-only and is never
    // named there, however published — it becomes a placeholder instead.
    const form = (status: string, access: string) =>
      isItemPubliclyVisible({ item_type: 'FORM', form: { status, access } } as never);

    expect(form('OPEN', 'PUBLIC')).toBe(true);
    expect(form('CLOSED', 'PUBLIC')).toBe(true);
    expect(form('OPEN', 'CLASSROOM')).toBe(false);
    expect(form('CLOSED', 'CLASSROOM')).toBe(false);
    // PUBLIC does not rescue a draft: it is invisible to enrolled students too.
    expect(form('DRAFT', 'PUBLIC')).toBe(false);
    expect(isItemPubliclyVisible({ item_type: 'FORM', form: null } as never)).toBe(false);
  });
});

describe('setPublic', () => {
  it('flips only is_public, leaving the in-app publish state alone', async () => {
    moduleUpdate.mockResolvedValue({ id: 'mod1' });
    await setPublic('mod1', true);
    expect(moduleUpdate).toHaveBeenCalledWith({ where: { id: 'mod1' }, data: { is_public: true } });
  });

  it('refuses a module from another classroom when a scope is given', async () => {
    moduleFindFirst.mockResolvedValue(null);
    await expect(setPublic('mod1', true, 'class-2')).rejects.toThrow(
      'Module not found in classroom'
    );
    expect(moduleUpdate).not.toHaveBeenCalled();
  });
});

describe('deleteById', () => {
  // deleteById runs its check and its delete inside one interactive
  // transaction; hand it a client whose calls are the mocks below. The
  // transaction's delete is its OWN mock, apart from the root client's
  // `moduleDelete`: a delete issued outside the transaction would not be under
  // the lock, and has to fail these tests.
  const txModuleDelete = vi.fn();
  const tx = {
    $queryRaw: queryRaw,
    assignment: { findMany: assignmentFindMany, deleteMany: assignmentDeleteMany },
    module: { delete: txModuleDelete },
  };
  beforeEach(() => {
    transaction.mockImplementation(async (run: (client: typeof tx) => unknown) => run(tx));
    queryRaw.mockResolvedValue([{ id: 'mod1' }]);
    moduleFindFirst.mockResolvedValue({ id: 'mod1' });
    txModuleDelete.mockResolvedValue({ id: 'mod1' });
  });

  it('refuses a module that owns any assignment, of any kind, and deletes nothing', async () => {
    // One read over every assignment type: the refusal does not care whether
    // the page listed them.
    for (const type of ['REPO', 'QUIZ', 'FORM']) {
      assignmentFindMany.mockResolvedValue([{ id: 'a1', type }]);

      await expect(deleteById('mod1', 'class-1')).rejects.toThrow('Module still has assignments');
    }
    expect(assignmentFindMany).toHaveBeenCalledWith({
      where: { module_id: 'mod1' },
      select: { id: true, type: true },
    });
    expect(assignmentDeleteMany).not.toHaveBeenCalled();
    expect(txModuleDelete).not.toHaveBeenCalled();
    expect(moduleDelete).not.toHaveBeenCalled();
  });

  it('where quizzes are hidden, takes only-quiz assignments with the module and says which', async () => {
    assignmentFindMany.mockResolvedValue([
      { id: 'q1', type: 'QUIZ' },
      { id: 'q2', type: 'QUIZ' },
    ]);

    const deleted = await deleteById('mod1', 'class-1', { quizzesHidden: true });

    expect(assignmentDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['q1', 'q2'] }, type: 'QUIZ' },
    });
    expect(txModuleDelete).toHaveBeenCalledWith({ where: { id: 'mod1' } });
    expect(deleted.deleted_quiz_assignment_ids).toEqual(['q1', 'q2']);
  });

  it('where quizzes are hidden, still refuses a module that also owns other assignments', async () => {
    assignmentFindMany.mockResolvedValue([
      { id: 'q1', type: 'QUIZ' },
      { id: 'r1', type: 'REPO' },
    ]);

    await expect(deleteById('mod1', 'class-1', { quizzesHidden: true })).rejects.toThrow(
      'Module still has assignments'
    );
    expect(assignmentDeleteMany).not.toHaveBeenCalled();
    expect(txModuleDelete).not.toHaveBeenCalled();
  });

  it('deletes a module with no assignments, leaving its items to the cascade', async () => {
    assignmentFindMany.mockResolvedValue([]);

    await deleteById('mod1', 'class-1');

    expect(moduleFindFirst).toHaveBeenCalledWith({
      where: { id: 'mod1', classroom_id: 'class-1' },
      select: { id: true },
    });
    // Inside the transaction, never on the root client.
    expect(txModuleDelete).toHaveBeenCalledWith({ where: { id: 'mod1' } });
    expect(moduleDelete).not.toHaveBeenCalled();
    // Its ModuleItem rows go with it through the foreign key (ON DELETE
    // CASCADE); the pages, quizzes, slides and forms they point at stay.
    expect(itemDeleteMany).not.toHaveBeenCalled();
  });

  it('locks the module row before it counts, and counts before it deletes', async () => {
    // The order is the whole point: an assignment moved in at the same moment
    // must be either counted or kept out, never cascade-deleted.
    assignmentFindMany.mockResolvedValue([]);

    await deleteById('mod1', 'class-1');

    expect(transaction).toHaveBeenCalledTimes(1);
    const [lock] = queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(lock.join('?')).toMatch(/FROM modules WHERE id = \? FOR UPDATE/);
    expect(queryRaw.mock.calls[0][1]).toBe('mod1');
    const at = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0];
    expect(at(queryRaw)).toBeLessThan(at(assignmentFindMany));
    expect(at(assignmentFindMany)).toBeLessThan(at(txModuleDelete));
  });

  it('reports a module another delete removed while this one waited for the row', async () => {
    // The scoped check passed, then the lock came back with no row: the same
    // refusal as a module that was never there, not a failed DELETE.
    queryRaw.mockResolvedValue([]);

    await expect(deleteById('mod1', 'class-1')).rejects.toThrow('Module not found in classroom');
    expect(assignmentFindMany).not.toHaveBeenCalled();
    expect(txModuleDelete).not.toHaveBeenCalled();
  });

  it('refuses a module from another classroom before looking at it', async () => {
    moduleFindFirst.mockResolvedValue(null);

    await expect(deleteById('mod1', 'class-2')).rejects.toThrow('Module not found in classroom');
    expect(transaction).not.toHaveBeenCalled();
    expect(txModuleDelete).not.toHaveBeenCalled();
  });
});

describe('addItem', () => {
  it('appends at position 0 when the module is empty', async () => {
    itemFindFirst.mockResolvedValue(null);
    itemCreate.mockResolvedValue({ id: 'mi1' });

    await addItem('mod1', 'SLIDE', 'slide1');

    expect(itemCreate).toHaveBeenCalledWith({
      data: { module_id: 'mod1', item_type: 'SLIDE', position: 0, slide_id: 'slide1' },
    });
  });

  it('refuses QUIZ: a quiz is placed in a module by its assignment', async () => {
    await expect(addItem('mod1', 'QUIZ', 'quiz1')).rejects.toThrow('from the quiz form');
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it('refuses REPOSITORY: repositories are attached to assignments, not modules', async () => {
    await expect(addItem('mod1', 'REPOSITORY' as never, 'repo1')).rejects.toThrow(
      'Repositories are attached to assignments'
    );
    expect(itemCreate).not.toHaveBeenCalled();
  });

  it('appends after the last item and maps type to the right column', async () => {
    itemFindFirst.mockResolvedValue({ position: 4 });
    itemCreate.mockResolvedValue({ id: 'mi2' });

    await addItem('mod1', 'PAGE', 'page9');

    expect(itemCreate).toHaveBeenCalledWith({
      data: { module_id: 'mod1', item_type: 'PAGE', position: 5, page_id: 'page9' },
    });
  });
});

describe('reorderItems', () => {
  it('sets each item position to its index, scoped to the module', async () => {
    itemFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    transaction.mockResolvedValue([]);
    await reorderItems('mod1', ['b', 'a', 'c']);

    expect(itemFindMany).toHaveBeenCalledWith({
      // Legacy REPOSITORY and QUIZ items are not in the content list and keep
      // their positions; only content items take part in the exact-set check.
      where: { module_id: 'mod1', item_type: { notIn: ['REPOSITORY', 'QUIZ'] } },
      select: { id: true },
    });
    expect(itemUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: 'b', module_id: 'mod1' },
      data: { position: 0 },
    });
    expect(itemUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: 'a', module_id: 'mod1' },
      data: { position: 1 },
    });
    expect(itemUpdate).toHaveBeenNthCalledWith(3, {
      where: { id: 'c', module_id: 'mod1' },
      data: { position: 2 },
    });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('rejects incomplete item order payloads', async () => {
    itemFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await expect(reorderItems('mod1', ['b'])).rejects.toThrow(
      'Ordered item ids must match module items'
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate item ids in order payloads', async () => {
    itemFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await expect(reorderItems('mod1', ['a', 'a'])).rejects.toThrow(
      'Ordered item ids must match module items'
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('listForClassroom', () => {
  beforeEach(() => {
    classroomFindUnique.mockResolvedValue({ id: 'c1' });
  });

  it('filters out unpublished items for students', async () => {
    moduleFindMany.mockResolvedValue([
      {
        id: 'm1',
        items: [
          { item_type: 'PAGE', page: { classroom_id: 'c1', is_draft: false } },
          { item_type: 'PAGE', page: { classroom_id: 'c1', is_draft: true } },
          { item_type: 'REPOSITORY', repository: { classroom_id: 'c1', is_published: true } },
        ],
      },
    ]);

    const result = await listForClassroom('cls');

    expect(moduleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classroom_id: 'c1', is_published: true } })
    );
    expect(result[0].items).toHaveLength(2);
  });

  it('returns everything unfiltered for the teaching team', async () => {
    const modules = [
      { id: 'm1', items: [{ item_type: 'PAGE', page: { classroom_id: 'c1', is_draft: true } }] },
    ];
    moduleFindMany.mockResolvedValue(modules);

    const result = await listForClassroom('cls', { includeUnpublished: true });

    expect(moduleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classroom_id: 'c1' } })
    );
    expect(result[0].items).toHaveLength(1);
  });

  it('returns [] when the classroom does not exist', async () => {
    classroomFindUnique.mockResolvedValue(null);
    expect(await listForClassroom('missing')).toEqual([]);
  });

  describe('assignments under the student-visibility rule', () => {
    const FUTURE = new Date(Date.now() + 7 * 86_400_000);
    const assignment = (id: string, type: string, over: Record<string, unknown> = {}) => ({
      id,
      type,
      is_published: true,
      release_at: null,
      repository: type === 'REPO' ? { is_published: true } : null,
      quiz: type === 'QUIZ' ? { status: 'PUBLISHED' } : null,
      form: type === 'FORM' ? { status: 'OPEN' } : null,
      ...over,
    });
    const MODULE = {
      id: 'm1',
      items: [],
      assignments: [
        assignment('repo', 'REPO'),
        assignment('repo-unpublished-repo', 'REPO', { repository: { is_published: false } }),
        assignment('unpublished', 'FORM', { is_published: false }),
        assignment('quiz', 'QUIZ'),
        // Past its close date: visible, it only takes no new attempt.
        assignment('quiz-closed', 'QUIZ', { closes_at: new Date(Date.now() - 1000) }),
        assignment('quiz-draft', 'QUIZ', { is_published: false }),
        assignment('quiz-later', 'QUIZ', { release_at: FUTURE }),
        assignment('form', 'FORM'),
        assignment('form-draft', 'FORM', { form: { status: 'DRAFT' } }),
        assignment('form-later', 'FORM', { release_at: FUTURE }),
      ],
    };

    it('shows students only what the rule admits', async () => {
      moduleFindMany.mockResolvedValue([MODULE]);

      const [module] = await listForClassroom('cls', { quizzesVisible: true });

      expect(module.assignments.map(a => a.id)).toEqual(['repo', 'quiz', 'quiz-closed', 'form']);
    });

    it('shows students no quiz assignment where quizzes are hidden', async () => {
      moduleFindMany.mockResolvedValue([MODULE]);

      const [module] = await listForClassroom('cls', { quizzesVisible: false });

      expect(module.assignments.map(a => a.id)).toEqual(['repo', 'form']);
    });

    it('treats quizzes as hidden unless the caller says otherwise', async () => {
      moduleFindMany.mockResolvedValue([MODULE]);

      const [module] = await listForClassroom('cls');

      expect(module.assignments.some(a => a.type === 'QUIZ')).toBe(false);
    });

    it('leaves the teaching team every assignment', async () => {
      moduleFindMany.mockResolvedValue([MODULE]);

      const [module] = await listForClassroom('cls', {
        includeUnpublished: true,
        quizzesVisible: false,
      });

      expect(module.assignments).toHaveLength(MODULE.assignments.length);
    });
  });
});
