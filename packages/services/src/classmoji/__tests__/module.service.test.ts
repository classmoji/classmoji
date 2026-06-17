import { describe, it, expect, vi, beforeEach } from 'vitest';

const classroomFindFirst = vi.fn();
const moduleFindMany = vi.fn();
const itemFindFirst = vi.fn();
const itemCreate = vi.fn();
const itemUpdate = vi.fn();
const transaction = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findFirst: classroomFindFirst },
    module: { findMany: moduleFindMany },
    moduleItem: { findFirst: itemFindFirst, create: itemCreate, update: itemUpdate },
    $transaction: transaction,
  }),
}));

vi.mock('@classmoji/utils', () => ({ titleToIdentifier: (s: string) => s.toLowerCase() }));

const { isItemPublished, addItem, reorderItems, listForClassroom } = await import(
  '../module.service.ts'
);

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

  it('hides an item whose target is missing', () => {
    expect(isItemPublished({ item_type: 'SLIDE', slide: null } as never)).toBe(false);
  });
});

describe('addItem', () => {
  it('appends at position 0 when the module is empty', async () => {
    itemFindFirst.mockResolvedValue(null);
    itemCreate.mockResolvedValue({ id: 'mi1' });

    await addItem('mod1', 'REPOSITORY', 'repo1');

    expect(itemCreate).toHaveBeenCalledWith({
      data: { module_id: 'mod1', item_type: 'REPOSITORY', position: 0, repository_id: 'repo1' },
    });
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
    transaction.mockResolvedValue([]);
    await reorderItems('mod1', ['b', 'a', 'c']);

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
});

describe('listForClassroom', () => {
  beforeEach(() => {
    classroomFindFirst.mockResolvedValue({ id: 'c1' });
  });

  it('filters out unpublished items for students', async () => {
    moduleFindMany.mockResolvedValue([
      {
        id: 'm1',
        items: [
          { item_type: 'PAGE', page: { is_draft: false } },
          { item_type: 'PAGE', page: { is_draft: true } },
          { item_type: 'REPOSITORY', repository: { is_published: true } },
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
    const modules = [{ id: 'm1', items: [{ item_type: 'PAGE', page: { is_draft: true } }] }];
    moduleFindMany.mockResolvedValue(modules);

    const result = await listForClassroom('cls', { includeUnpublished: true });

    expect(moduleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classroom_id: 'c1' } })
    );
    expect(result[0].items).toHaveLength(1);
  });

  it('returns [] when the classroom does not exist', async () => {
    classroomFindFirst.mockResolvedValue(null);
    expect(await listForClassroom('missing')).toEqual([]);
  });
});
