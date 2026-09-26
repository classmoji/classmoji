/**
 * Unit tests for the repository form action (admin.$class.repos_.form).
 *
 * Authorization binds to `params.class`, while the repository id, the team tag
 * and the linked page/slide ids arrive in the request body. These tests pin that
 * every one of them is scoped to the authorized classroom before anything is
 * written, and that a normal save from the form still works unchanged:
 *   - update: the repository is looked up by (id, classroom_id) first; an
 *     unknown id returns the route's error shape and writes nothing, and the
 *     service write is handed the classroom id too;
 *   - create/update: a tag that is not one of this classroom's tags is refused;
 *   - linked pages/slides outside this classroom are ignored, not linked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  repositoryFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  slideFindMany: vi.fn(),
  pageLinkFindMany: vi.fn(),
  pageLinkCreateMany: vi.fn(),
  pageLinkDeleteMany: vi.fn(),
  slideLinkFindMany: vi.fn(),
  slideLinkCreateMany: vi.fn(),
  slideLinkDeleteMany: vi.fn(),
  tagsByClassroom: vi.fn(),
  updateFromForm: vi.fn(),
  repositoryCreate: vi.fn(),
  createFromFormData: vi.fn(),
  replaceTests: vi.fn(),
  saveManifest: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repository: { findFirst: (...a: unknown[]) => mocks.repositoryFindFirst(...a) },
    page: { findMany: (...a: unknown[]) => mocks.pageFindMany(...a) },
    slide: { findMany: (...a: unknown[]) => mocks.slideFindMany(...a) },
    pageLink: {
      findMany: (...a: unknown[]) => mocks.pageLinkFindMany(...a),
      createMany: (...a: unknown[]) => mocks.pageLinkCreateMany(...a),
      deleteMany: (...a: unknown[]) => mocks.pageLinkDeleteMany(...a),
    },
    slideLink: {
      findMany: (...a: unknown[]) => mocks.slideLinkFindMany(...a),
      createMany: (...a: unknown[]) => mocks.slideLinkCreateMany(...a),
      deleteMany: (...a: unknown[]) => mocks.slideLinkDeleteMany(...a),
    },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    organizationTag: { findByClassroomId: (...a: unknown[]) => mocks.tagsByClassroom(...a) },
    repository: {
      updateFromForm: (...a: unknown[]) => mocks.updateFromForm(...a),
      create: (...a: unknown[]) => mocks.repositoryCreate(...a),
      createFromFormData: (...a: unknown[]) => mocks.createFromFormData(...a),
    },
    autogradingTest: { replaceForRepository: (...a: unknown[]) => mocks.replaceTests(...a) },
    contentManifest: { saveManifest: (...a: unknown[]) => mocks.saveManifest(...a) },
  },
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('../admin.$class.repos_.form/FormModule', () => ({ default: () => null }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn(), useParams: () => ({}) }));

const route = await import('../admin.$class.repos_.form/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const OWN_REPO = 'repo-1';
const OWN_TAG = 'tag-1';

const submit = (intent: 'create' | 'update', body: Record<string, unknown>) =>
  route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/repos/form?/${intent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

/** A body as FormModule submits it for an existing GROUP repository. */
const FORM_BODY = {
  id: OWN_REPO,
  title: 'lab-2',
  type: 'GROUP',
  tag: OWN_TAG,
  template: 'org/lab-template',
  organization: CLASS_SLUG,
  description: 'Pairs',
  team_formation_mode: 'INSTRUCTOR',
  team_formation_deadline: null,
  max_team_size: 2,
  project_template_id: null,
  project_template_title: null,
  linkedPageIds: ['page-own', 'page-other'],
  linkedSlideIds: ['slide-own', 'slide-other'],
  autogradingTests: [],
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.repositoryFindFirst.mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve(args.where.id === OWN_REPO ? { id: OWN_REPO } : null)
  );
  mocks.tagsByClassroom.mockResolvedValue([{ id: OWN_TAG, name: 'workshop-pairs' }]);
  // Only this classroom's pages/slides come back from the classroom-scoped lookups.
  mocks.pageFindMany.mockResolvedValue([{ id: 'page-own' }]);
  mocks.slideFindMany.mockResolvedValue([{ id: 'slide-own' }]);
  mocks.pageLinkFindMany.mockResolvedValue([]);
  mocks.slideLinkFindMany.mockResolvedValue([]);
  mocks.updateFromForm.mockResolvedValue({ id: OWN_REPO });
  mocks.createFromFormData.mockImplementation((_values, classroomId, tagId) => ({
    classroom_id: classroomId,
    tag_id: tagId,
  }));
  mocks.repositoryCreate.mockResolvedValue({ id: 'repo-new' });
  mocks.replaceTests.mockResolvedValue([]);
  mocks.saveManifest.mockResolvedValue(true);
});

describe('repository form: update', () => {
  it('saves a normal form submission, with the classroom scope handed to the write', async () => {
    const result = await submit('update', FORM_BODY);

    expect(result).toMatchObject({ success: 'Repository updated' });
    expect(mocks.repositoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OWN_REPO, classroom_id: 'class-1' } })
    );
    expect(mocks.updateFromForm).toHaveBeenCalledWith(
      expect.objectContaining({ id: OWN_REPO, tag: OWN_TAG, title: 'lab-2' }),
      'class-1'
    );
    expect(mocks.replaceTests).toHaveBeenCalledWith(OWN_REPO, []);
    expect(mocks.saveManifest).toHaveBeenCalledWith('class-1');
  });

  it('returns the error shape for a repository id outside the classroom and writes nothing', async () => {
    const result = await submit('update', { ...FORM_BODY, id: 'repo-elsewhere' });

    expect(result).toEqual({ error: 'Repository not found.', action: expect.any(String) });
    expect(mocks.updateFromForm).not.toHaveBeenCalled();
    expect(mocks.pageLinkCreateMany).not.toHaveBeenCalled();
    expect(mocks.slideLinkCreateMany).not.toHaveBeenCalled();
    expect(mocks.replaceTests).not.toHaveBeenCalled();
  });

  it('returns the error shape for a missing or non-string repository id', async () => {
    for (const id of [undefined, { not: '' }]) {
      const result = await submit('update', { ...FORM_BODY, id });
      expect(result).toMatchObject({ error: 'Repository not found.' });
    }
    expect(mocks.repositoryFindFirst).not.toHaveBeenCalled();
    expect(mocks.updateFromForm).not.toHaveBeenCalled();
  });

  it('refuses a tag that is not one of this classroom’s tags', async () => {
    const result = await submit('update', { ...FORM_BODY, tag: 'tag-elsewhere' });

    expect(result).toMatchObject({ error: expect.stringContaining('team tag') });
    expect(mocks.updateFromForm).not.toHaveBeenCalled();
  });

  it('links only the pages and slides of this classroom', async () => {
    await submit('update', FORM_BODY);

    expect(mocks.pageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['page-own', 'page-other'] }, classroom_id: 'class-1' },
      })
    );
    expect(mocks.pageLinkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ page_id: 'page-own', repository_id: OWN_REPO }] })
    );
    expect(mocks.slideLinkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ slide_id: 'slide-own', repository_id: OWN_REPO }] })
    );
  });

  it('refuses a tag that is not a string (object or array)', async () => {
    for (const tag of [{ id: OWN_TAG }, [OWN_TAG]]) {
      const result = await submit('update', { ...FORM_BODY, tag });
      expect(result).toMatchObject({ error: expect.stringContaining('team tag') });
    }
    expect(mocks.updateFromForm).not.toHaveBeenCalled();
  });

  it('still saves an INDIVIDUAL repository whose stored tag is not one of this classroom’s', async () => {
    // FormModule always sends the stored tag_id; for INDIVIDUAL the service ignores it.
    const result = await submit('update', {
      ...FORM_BODY,
      type: 'INDIVIDUAL',
      tag: 'tag-left-over',
    });

    expect(result).toMatchObject({ success: 'Repository updated' });
    expect(mocks.tagsByClassroom).not.toHaveBeenCalled();
    expect(mocks.updateFromForm).toHaveBeenCalledWith(
      expect.objectContaining({ id: OWN_REPO, type: 'INDIVIDUAL' }),
      'class-1'
    );
  });

  it('reports a title already used in the classroom', async () => {
    mocks.updateFromForm.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const result = await submit('update', FORM_BODY);

    expect(result).toEqual({
      error: 'A repository with this title already exists.',
      action: expect.any(String),
    });
    expect(mocks.replaceTests).not.toHaveBeenCalled();
  });

  it('removes links only from the verified repository', async () => {
    mocks.pageLinkFindMany.mockResolvedValue([{ page_id: 'page-own' }, { page_id: 'page-gone' }]);
    mocks.slideLinkFindMany.mockResolvedValue([{ slide_id: 'slide-gone' }]);

    await submit('update', FORM_BODY);

    expect(mocks.pageLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { repository_id: OWN_REPO } })
    );
    expect(mocks.pageLinkDeleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { repository_id: OWN_REPO, page_id: { in: ['page-gone'] } },
    });
    expect(mocks.slideLinkDeleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { repository_id: OWN_REPO, slide_id: { in: ['slide-gone'] } },
    });
  });
});

describe('repository form: create', () => {
  it('builds the create data from the form fields in the route classroom', async () => {
    const { id: _id, ...body } = FORM_BODY;
    const result = await submit('create', { ...body, classroom_id: 'class-elsewhere' });

    expect(result).toMatchObject({ success: 'Repository created' });
    expect(mocks.createFromFormData).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'lab-2' }),
      'class-1',
      OWN_TAG
    );
    expect(mocks.repositoryCreate).toHaveBeenCalledWith({
      classroom_id: 'class-1',
      tag_id: OWN_TAG,
    });
    expect(mocks.pageLinkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [{ page_id: 'page-own', repository_id: 'repo-new' }] })
    );
  });

  it('refuses a tag that is not one of this classroom’s tags and creates nothing', async () => {
    const { id: _id, ...body } = FORM_BODY;
    const result = await submit('create', { ...body, tag: 'tag-elsewhere' });

    expect(result).toMatchObject({ error: expect.stringContaining('team tag') });
    expect(mocks.repositoryCreate).not.toHaveBeenCalled();
  });

  it('refuses a tag that is not a string (object or array) and creates nothing', async () => {
    const { id: _id, ...body } = FORM_BODY;
    for (const tag of [{ id: OWN_TAG }, [OWN_TAG]]) {
      const result = await submit('create', { ...body, tag });
      expect(result).toMatchObject({ error: expect.stringContaining('team tag') });
    }
    expect(mocks.repositoryCreate).not.toHaveBeenCalled();
  });

  it('reports a title already used in the classroom', async () => {
    mocks.repositoryCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const { id: _id, ...body } = FORM_BODY;
    const result = await submit('create', body);

    expect(result).toEqual({
      error: 'A repository with this title already exists.',
      action: expect.any(String),
    });
  });

  it('creates an INDIVIDUAL repository with no tag', async () => {
    const { id: _id, ...body } = FORM_BODY;
    const result = await submit('create', { ...body, type: 'INDIVIDUAL', tag: null });

    expect(result).toMatchObject({ success: 'Repository created' });
    expect(mocks.createFromFormData).toHaveBeenCalledWith(expect.anything(), 'class-1', null);
    expect(mocks.tagsByClassroom).not.toHaveBeenCalled();
  });
});
