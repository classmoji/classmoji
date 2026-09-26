import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteMany = vi.fn();
const updateMany = vi.fn();
const findFirst = vi.fn();
const findUniqueOrThrow = vi.fn();
const tagFindFirst = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repository: { deleteMany, updateMany, findFirst, findUniqueOrThrow },
    tag: { findFirst: tagFindFirst },
  }),
}));

vi.mock('@classmoji/utils', () => ({ titleToIdentifier: (s: string) => s.toLowerCase() }));

vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  getStudentsInClassroom: vi.fn(async () => []),
  createNotifications: vi.fn(),
}));

const {
  createFromFormData,
  deleteById,
  deleteIfUnprovisioned,
  findDependents,
  setPublished,
  update,
  updateFromForm,
} = await import('../repository.service.ts');

/** Every prisma method the service could reach — asserted untouched by the guard. */
const allPrismaCalls = () => [deleteMany, updateMany, findFirst, findUniqueOrThrow, tagFindFirst];

/** Ids that survive `if (!id)` but widen a scoped `where` to the whole classroom. */
const unusableIds: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['a StringFilter object', { not: '' }],
  ['an empty string', ''],
  ['a number', 7],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteById', () => {
  it.each(unusableIds)('rejects %s as an id before issuing any query', async (_label, id) => {
    await expect(deleteById(id as string, 'classroom-1')).rejects.toThrow('Invalid repository id');
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before any query', async (_label, cid) => {
    await expect(deleteById('repo-1', cid as string)).rejects.toThrow('Invalid classroom id');
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('scopes the delete to the authorized classroom', async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await expect(deleteById('repo-1', 'classroom-1')).resolves.toEqual({ id: 'repo-1' });
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'repo-1', classroom_id: 'classroom-1' },
    });
  });

  it('throws when the id did not belong to the classroom', async () => {
    deleteMany.mockResolvedValue({ count: 0 });
    await expect(deleteById('repo-1', 'other-classroom')).rejects.toThrow(
      'Repository not found in classroom'
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('setPublished', () => {
  it.each(unusableIds)('rejects %s as an id before the pre-read', async (_label, id) => {
    await expect(setPublished(id as string, true, 'classroom-1')).rejects.toThrow(
      'Invalid repository id'
    );
    // The pre-read matters as much as the write: an unusable id would make it
    // return an arbitrary repository in the classroom.
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before the pre-read', async (_label, cid) => {
    await expect(setPublished('repo-1', true, cid as string)).rejects.toThrow(
      'Invalid classroom id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('scopes the flip to the authorized classroom', async () => {
    findFirst.mockResolvedValue({ is_published: false });
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({
      id: 'repo-1',
      classroom_id: 'classroom-1',
      title: 'HW1',
    });

    await expect(setPublished('repo-1', true, 'classroom-1')).resolves.toMatchObject({
      id: 'repo-1',
    });
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'repo-1', classroom_id: 'classroom-1' },
      data: { is_published: true },
    });
  });

  it('throws without reading the row back when the repo was another classroom', async () => {
    findFirst.mockResolvedValue(null);
    updateMany.mockResolvedValue({ count: 0 });

    await expect(setPublished('repo-1', true, 'other-classroom')).rejects.toThrow(
      'Repository not found in classroom'
    );
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  it.each(unusableIds)('rejects %s as an id before issuing any query', async (_label, id) => {
    await expect(update(id as string, { description: 'updated' }, 'classroom-1')).rejects.toThrow(
      'Invalid repository id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before any query', async (_label, cid) => {
    await expect(update('repo-1', { description: 'updated' }, cid as string)).rejects.toThrow(
      'Invalid classroom id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('scopes the write to the authorized classroom and returns the row', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue({
      id: 'repo-1',
      description: 'updated',
      assignments: [],
      tag: null,
    });

    await expect(
      update('repo-1', { description: 'updated' }, 'classroom-1')
    ).resolves.toMatchObject({
      id: 'repo-1',
      description: 'updated',
    });
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'repo-1', classroom_id: 'classroom-1' },
      data: { description: 'updated' },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'repo-1', classroom_id: 'classroom-1' } })
    );
  });

  it('throws when the repository lives in another classroom', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(update('repo-1', { description: 'updated' }, 'other-classroom')).rejects.toThrow(
      'Repository not found in classroom'
    );
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('findDependents', () => {
  it.each(unusableIds)('rejects %s as an id before issuing any query', async (_label, id) => {
    await expect(findDependents(id as string, 'classroom-1')).rejects.toThrow(
      'Invalid repository id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before any query', async (_label, cid) => {
    await expect(findDependents('repo-1', cid as string)).rejects.toThrow('Invalid classroom id');
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('reads inside the authorized classroom and counts the git repos', async () => {
    findFirst.mockResolvedValue(null);

    await expect(findDependents('repo-1', 'other-classroom')).resolves.toBeNull();
    const query = findFirst.mock.calls[0][0] as {
      where: unknown;
      select: { _count: { select: Record<string, boolean> } };
    };
    expect(query.where).toEqual({ id: 'repo-1', classroom_id: 'other-classroom' });
    expect(query.select._count.select).toMatchObject({ git_repos: true, module_items: true });
  });

  it('counts the links hanging off each assignment', async () => {
    findFirst.mockResolvedValue(null);
    await findDependents('repo-1', 'classroom-1');
    const query = findFirst.mock.calls[0][0] as {
      select: { assignments: { select: { _count: { select: Record<string, boolean> } } } };
    };
    expect(query.select.assignments.select._count.select).toEqual({
      pages: true,
      slides: true,
      calendarEventLinks: true,
    });
  });
});

describe('update — immutable columns', () => {
  it('strips id, classroom_id, slug and title at runtime, whatever the type says', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue({ id: 'repo-1' });

    const smuggled = {
      description: 'ok',
      id: 'other-id',
      classroom_id: 'other-classroom',
      slug: 'renamed',
      title: 'Renamed',
    } as unknown as Parameters<typeof update>[1];
    await update('repo-1', smuggled, 'classroom-1');

    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'repo-1', classroom_id: 'classroom-1' },
      data: { description: 'ok' },
    });
  });
});

describe('deleteIfUnprovisioned', () => {
  it.each(unusableIds)('rejects %s as an id before issuing any query', async (_label, id) => {
    await expect(deleteIfUnprovisioned(id as string, 'classroom-1')).rejects.toThrow(
      'Invalid repository id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before any query', async (_label, cid) => {
    await expect(deleteIfUnprovisioned('repo-1', cid as string)).rejects.toThrow(
      'Invalid classroom id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('puts "unpublished and nothing provisioned" into the DELETE itself', async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await expect(deleteIfUnprovisioned('repo-1', 'classroom-1')).resolves.toEqual({
      status: 'deleted',
    });
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: 'repo-1',
        classroom_id: 'classroom-1',
        is_published: false,
        git_repos: { none: {} },
      },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', null, { status: 'not_found' }],
    ['published', { is_published: true, _count: { git_repos: 0 } }, { status: 'published' }],
    [
      'provisioned',
      { is_published: false, _count: { git_repos: 3 } },
      { status: 'provisioned', gitRepos: 3 },
    ],
  ])('reports %s when nothing was deleted', async (_label, row, expected) => {
    deleteMany.mockResolvedValue({ count: 0 });
    findFirst.mockResolvedValue(row);
    await expect(deleteIfUnprovisioned('repo-1', 'classroom-1')).resolves.toEqual(expected);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'repo-1', classroom_id: 'classroom-1' } })
    );
  });
});

/** A repository-form body as FormModule submits it, plus columns the form does not own. */
const FORM_BODY = {
  id: 'repo-1',
  title: 'lab-2',
  type: 'GROUP' as const,
  template: 'org/lab-template',
  description: 'Pairs',
  team_formation_mode: 'INSTRUCTOR',
  team_formation_deadline: '2026-10-02T03:59:00.000Z',
  max_team_size: 2,
  project_template_id: null,
  project_template_title: null,
  tag: 'tag-1',
};

const NON_FORM_COLUMNS = {
  classroom_id: 'other-classroom',
  slug: 'renamed-slug',
  is_published: true,
  created_at: '2020-01-01T00:00:00.000Z',
};

describe('updateFromForm', () => {
  it.each(unusableIds)('rejects %s as an id before issuing any query', async (_label, id) => {
    await expect(updateFromForm({ ...FORM_BODY, id: id as string }, 'classroom-1')).rejects.toThrow(
      'Invalid repository id'
    );
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a classroom id before any query', async (_label, cid) => {
    await expect(updateFromForm(FORM_BODY, cid as string)).rejects.toThrow('Invalid classroom id');
    for (const fn of allPrismaCalls()) expect(fn).not.toHaveBeenCalled();
  });

  it('scopes the write to the classroom and writes only the form-owned columns', async () => {
    tagFindFirst.mockResolvedValue({ id: 'tag-1' });
    updateMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue({ id: 'repo-1', title: 'lab-2' });

    await expect(
      updateFromForm({ ...FORM_BODY, ...NON_FORM_COLUMNS }, 'classroom-1')
    ).resolves.toMatchObject({ id: 'repo-1' });

    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'repo-1', classroom_id: 'classroom-1' },
      data: {
        title: 'lab-2',
        type: 'GROUP',
        template: 'org/lab-template',
        description: 'Pairs',
        team_formation_mode: 'INSTRUCTOR',
        team_formation_deadline: new Date('2026-10-02T03:59:00.000Z'),
        max_team_size: 2,
        project_template_id: null,
        project_template_title: null,
        tag_id: 'tag-1',
      },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'repo-1', classroom_id: 'classroom-1' } })
    );
  });

  it('checks the tag against the same classroom', async () => {
    tagFindFirst.mockResolvedValue({ id: 'tag-1' });
    updateMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue({ id: 'repo-1' });

    await updateFromForm(FORM_BODY, 'classroom-1');
    expect(tagFindFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'tag-1', classroom_id: 'classroom-1' },
      select: { id: true },
    });
  });

  it('refuses a tag of another classroom and writes nothing', async () => {
    tagFindFirst.mockResolvedValue(null);

    await expect(updateFromForm(FORM_BODY, 'classroom-1')).rejects.toThrow(
      'Tag not found in classroom'
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('leaves the tag alone for an INDIVIDUAL repository, as the form always has', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue({ id: 'repo-1' });

    await updateFromForm({ ...FORM_BODY, type: 'INDIVIDUAL' }, 'classroom-1');
    expect(tagFindFirst).not.toHaveBeenCalled();
    expect((updateMany.mock.calls[0][0] as { data: object }).data).not.toHaveProperty('tag_id');
  });

  it('throws and reads nothing back when the repository is in another classroom', async () => {
    tagFindFirst.mockResolvedValue({ id: 'tag-1' });
    updateMany.mockResolvedValue({ count: 0 });

    await expect(updateFromForm(FORM_BODY, 'other-classroom')).rejects.toThrow(
      'Repository not found in classroom'
    );
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('createFromFormData', () => {
  it('keeps only form-owned columns and takes the classroom and tag from the caller', () => {
    const { id: _id, tag: _tag, ...body } = FORM_BODY;
    expect(createFromFormData({ ...body, ...NON_FORM_COLUMNS }, 'classroom-1', 'tag-1')).toEqual({
      title: 'lab-2',
      type: 'GROUP',
      template: 'org/lab-template',
      description: 'Pairs',
      team_formation_mode: 'INSTRUCTOR',
      team_formation_deadline: new Date('2026-10-02T03:59:00.000Z'),
      max_team_size: 2,
      project_template_id: null,
      project_template_title: null,
      classroom_id: 'classroom-1',
      tag_id: 'tag-1',
    });
  });

  it('leaves out fields the body does not carry', () => {
    expect(
      createFromFormData({ title: 'lab-3', type: 'INDIVIDUAL', template: 't' }, 'classroom-1', null)
    ).toEqual({
      title: 'lab-3',
      type: 'INDIVIDUAL',
      template: 't',
      classroom_id: 'classroom-1',
      tag_id: null,
    });
  });
});
