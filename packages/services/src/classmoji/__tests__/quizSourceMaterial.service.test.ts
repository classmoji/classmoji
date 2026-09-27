/**
 * quizSourceMaterial — load, countStartable and the write, against a mocked
 * Prisma and a mocked `getContentText`.
 *
 * The visibility rule itself is REAL (`contentVisibility` from
 * contentSearch.service): what is pinned here is that the loader applies it to
 * the LIVE record under the viewer's own highest role BEFORE any text is read,
 * so a draft is `not_visible` for a student and present for staff, and that
 * `getContentText`'s single not-found becomes `not_indexed` only for a record
 * the viewer may see. The real SQL runs in quizSourceMaterial.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const membershipFindMany = vi.fn();
const pageLinkFindMany = vi.fn();
const slideLinkFindMany = vi.fn();
const queryRaw = vi.fn();
const pageFindMany = vi.fn();
const slideFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroomMembership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    pageLink: { findMany: (...a: unknown[]) => pageLinkFindMany(...a) },
    slideLink: { findMany: (...a: unknown[]) => slideLinkFindMany(...a) },
    page: { findMany: (...a: unknown[]) => pageFindMany(...a) },
    slide: { findMany: (...a: unknown[]) => slideFindMany(...a) },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  }),
}));

const getContentText = vi.fn();
vi.mock('../contentSearch.service.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../contentSearch.service.ts')>()),
  getContentText: (...a: unknown[]) => getContentText(...a),
}));

const { ContentNotFoundError } = await import('../contentSearch.service.ts');
const { ResourceLinkServiceError } = await import('../resourceLink.service.ts');
const {
  loadQuizSourceMaterial,
  countStartableSourceMaterial,
  setQuizSourceMaterial,
  normalizeSourceMaterial,
  sourceMaterialOf,
  listSourceMaterialOptions,
  load,
  countStartable,
} = await import('../quizSourceMaterial.service.ts');

const CLASSROOM = 'classroom-1';
const ARGS = { quizId: 'quiz-1', classroomId: CLASSROOM, userId: 'user-1' };
const T0 = new Date('2026-09-01T00:00:00Z');

const record = (id: string, { is_draft = false, is_public = false, title = `Doc ${id}` } = {}) => ({
  id,
  title,
  is_draft,
  is_public,
});

/** Page links then slide links, each with its material position. */
function linkRows({
  pages = [] as Array<[number, ReturnType<typeof record>]>,
  slides = [] as Array<[number, ReturnType<typeof record>]>,
}) {
  pageLinkFindMany.mockResolvedValue(
    pages.map(([order, page]) => ({ order, created_at: T0, page }))
  );
  slideLinkFindMany.mockResolvedValue(
    slides.map(([order, slide]) => ({ order, created_at: T0, slide }))
  );
}

const asRole = (...roles: string[]) =>
  membershipFindMany.mockResolvedValue(roles.map(role => ({ role })));

const indexed = (text: string, sourceSha = 'sha') => ({
  docKind: 'page',
  docId: 'x',
  title: 'indexed title',
  sourcePath: 'p',
  text,
  chunkCount: 1,
  isDraft: null,
  sourceSha,
});

beforeEach(() => {
  vi.clearAllMocks();
  linkRows({});
  asRole('STUDENT');
  getContentText.mockImplementation(async ({ docId }: { docId: string }) =>
    indexed(`text of ${docId}`, `sha-${docId}`)
  );
});

describe('loadQuizSourceMaterial', () => {
  it('is exposed as `load` for ClassmojiService.quizSourceMaterial.load', () => {
    expect(load).toBe(loadQuizSourceMaterial);
    expect(countStartable).toBe(countStartableSourceMaterial);
  });

  it('returns the documents in material order across pages and decks, with their sha', async () => {
    linkRows({
      pages: [
        [2, record('p2')],
        [0, record('p0')],
      ],
      slides: [[1, record('s1')]],
    });

    const material = await loadQuizSourceMaterial(ARGS);

    expect(material.configured).toBe(3);
    expect(material.docs.map(d => `${d.kind}:${d.id}`)).toEqual(['page:p0', 'slide:s1', 'page:p2']);
    expect(material.docs[1]).toEqual({
      kind: 'slide',
      id: 's1',
      title: 'Doc s1',
      text: 'text of s1',
      truncated: false,
      sourceSha: 'sha-s1',
    });
    expect(material.omitted).toEqual([]);
    expect(material.truncated).toBe(false);
    expect(material.totalChars).toBe('text of p0text of s1text of p2'.length);
  });

  it('scopes the link reads to this quiz AND this classroom on both ends', async () => {
    await loadQuizSourceMaterial(ARGS);

    expect(pageLinkFindMany.mock.calls[0][0].where).toEqual({
      quiz_id: 'quiz-1',
      quiz: { classroom_id: CLASSROOM },
      page: { classroom_id: CLASSROOM },
    });
    expect(slideLinkFindMany.mock.calls[0][0].where).toEqual({
      quiz_id: 'quiz-1',
      quiz: { classroom_id: CLASSROOM },
      slide: { classroom_id: CLASSROOM },
    });
  });

  it('omits a draft for a student as not_visible, WITHOUT reading its text', async () => {
    linkRows({
      pages: [
        [0, record('draft', { is_draft: true })],
        [1, record('live')],
      ],
    });

    const material = await loadQuizSourceMaterial(ARGS);

    expect(material.docs.map(d => d.id)).toEqual(['live']);
    expect(material.omitted).toEqual([
      { kind: 'page', id: 'draft', title: 'Doc draft', reason: 'not_visible' },
    ]);
    expect(getContentText).toHaveBeenCalledTimes(1);
    expect(getContentText.mock.calls[0][0]).toMatchObject({ docId: 'live', role: 'STUDENT' });
  });

  it('includes a draft for staff, reading under the viewer’s HIGHEST role', async () => {
    // Both a STUDENT and an ASSISTANT row: the assistant row wins.
    asRole('STUDENT', 'ASSISTANT');
    linkRows({ pages: [[0, record('draft', { is_draft: true })]] });

    const material = await loadQuizSourceMaterial(ARGS);

    expect(material.docs.map(d => d.id)).toEqual(['draft']);
    expect(getContentText.mock.calls[0][0]).toEqual({
      classroomId: CLASSROOM,
      role: 'ASSISTANT',
      docKind: 'page',
      docId: 'draft',
    });
  });

  it('treats a non-member as outside: a non-public document is not_visible', async () => {
    asRole();
    linkRows({ pages: [[0, record('members-only')]] });

    const material = await loadQuizSourceMaterial(ARGS);
    expect(material.docs).toEqual([]);
    expect(material.omitted[0].reason).toBe('not_visible');
  });

  it('reports a visible document with no indexed text as not_indexed', async () => {
    linkRows({ pages: [[0, record('fresh')]] });
    getContentText.mockRejectedValue(new ContentNotFoundError());

    const material = await loadQuizSourceMaterial(ARGS);
    expect(material.docs).toEqual([]);
    expect(material.omitted).toEqual([
      { kind: 'page', id: 'fresh', title: 'Doc fresh', reason: 'not_indexed' },
    ]);
  });

  it('reports blank indexed text as empty', async () => {
    linkRows({ slides: [[0, record('blank')]] });
    getContentText.mockResolvedValue(indexed(' \n\n\t '));

    const material = await loadQuizSourceMaterial(ARGS);
    expect(material.omitted).toEqual([
      { kind: 'slide', id: 'blank', title: 'Doc blank', reason: 'empty' },
    ]);
  });

  it('rethrows a database failure rather than calling the document not indexed', async () => {
    linkRows({ pages: [[0, record('p')]] });
    getContentText.mockRejectedValue(new Error('connection reset'));

    await expect(loadQuizSourceMaterial(ARGS)).rejects.toThrow('connection reset');
  });

  it('puts budget omissions in material order among the others', async () => {
    const pages: Array<[number, ReturnType<typeof record>]> = Array.from({ length: 13 }, (_, i) => [
      i,
      record(`p${i}`),
    ]);
    pages.splice(1, 0, [0.5, record('draft', { is_draft: true })]);
    linkRows({ pages });

    const material = await loadQuizSourceMaterial(ARGS);

    expect(material.configured).toBe(14);
    expect(material.docs).toHaveLength(12);
    expect(material.omitted.map(d => `${d.id}:${d.reason}`)).toEqual([
      'draft:not_visible',
      'p12:budget',
    ]);
    expect(material.truncated).toBe(true);
  });

  it('reads in material order and never reads past the document cap', async () => {
    const pages: Array<[number, ReturnType<typeof record>]> = Array.from({ length: 15 }, (_, i) => [
      i,
      record(`p${i}`),
    ]);
    pages.push([15, record('late-draft', { is_draft: true })]);
    linkRows({ pages });

    const material = await loadQuizSourceMaterial(ARGS);

    // Twelve documents have text: link 13 onward is never read.
    expect(getContentText.mock.calls.map(([args]) => args.docId)).toEqual(
      Array.from({ length: 12 }, (_, i) => `p${i}`)
    );
    expect(material.docs).toHaveLength(12);
    // Visibility still decides for every link, read or not.
    expect(material.omitted.map(d => `${d.id}:${d.reason}`)).toEqual([
      'p12:budget',
      'p13:budget',
      'p14:budget',
      'late-draft:not_visible',
    ]);
    expect(material.truncated).toBe(true);
  });

  it('does not spend a slot on a document with no text, and reads on to fill it', async () => {
    const pages: Array<[number, ReturnType<typeof record>]> = Array.from({ length: 13 }, (_, i) => [
      i,
      record(`p${i}`),
    ]);
    linkRows({ pages });
    getContentText.mockImplementation(async ({ docId }: { docId: string }) => {
      if (docId === 'p0') throw new ContentNotFoundError();
      return indexed(`text of ${docId}`);
    });

    const material = await loadQuizSourceMaterial(ARGS);

    expect(getContentText).toHaveBeenCalledTimes(13);
    expect(material.docs.map(d => d.id)).toEqual(Array.from({ length: 12 }, (_, i) => `p${i + 1}`));
    expect(material.omitted).toEqual([
      { kind: 'page', id: 'p0', title: 'Doc p0', reason: 'not_indexed' },
    ]);
    expect(material.truncated).toBe(false);
  });

  it('stops reading once the total is spent', async () => {
    // 60,000 + 60,000, then the third is cut to the 40,000 left: the total is
    // spent, so the fourth and fifth are budget without being read.
    const pages: Array<[number, ReturnType<typeof record>]> = Array.from({ length: 5 }, (_, i) => [
      i,
      record(`p${i}`),
    ]);
    linkRows({ pages });
    getContentText.mockImplementation(async () => indexed('x'.repeat(60_000)));

    const material = await loadQuizSourceMaterial(ARGS);

    expect(getContentText).toHaveBeenCalledTimes(3);
    expect(material.docs.map(d => [d.id, d.truncated])).toEqual([
      ['p0', false],
      ['p1', false],
      ['p2', true],
    ]);
    expect(material.omitted.map(d => `${d.id}:${d.reason}`)).toEqual(['p3:budget', 'p4:budget']);
  });

  it.each([
    ['quizId', { ...ARGS, quizId: undefined }],
    ['classroomId', { ...ARGS, classroomId: '' }],
    ['userId', { ...ARGS, userId: 7 }],
  ])(
    'refuses a missing %s before any read (Prisma would drop it and widen the query)',
    async (_l, args) => {
      await expect(loadQuizSourceMaterial(args as never)).rejects.toThrow('is required');
      expect(pageLinkFindMany).not.toHaveBeenCalled();
    }
  );
});

describe('countStartableSourceMaterial', () => {
  it('is zero and runs no index query when nothing is linked', async () => {
    await expect(countStartableSourceMaterial(ARGS)).resolves.toEqual({
      configured: 0,
      startable: 0,
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('is zero without an index query when every linked document is a draft (student)', async () => {
    linkRows({
      pages: [[0, record('d1', { is_draft: true })]],
      slides: [[1, record('d2', { is_draft: true })]],
    });

    await expect(countStartableSourceMaterial(ARGS)).resolves.toEqual({
      configured: 2,
      startable: 0,
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('counts only visible documents that the index has non-blank text for', async () => {
    linkRows({
      pages: [
        [0, record('live')],
        [1, record('draft', { is_draft: true })],
      ],
      slides: [[2, record('deck')]],
    });
    queryRaw.mockResolvedValue([{ docKind: 'page', docId: 'live' }]);

    await expect(countStartableSourceMaterial(ARGS)).resolves.toEqual({
      configured: 3,
      startable: 1,
    });

    // The statement is scoped to the classroom and names only the VISIBLE ids.
    const sql = (queryRaw.mock.calls[0][0] as string[]).join('?');
    const call = JSON.stringify(queryRaw.mock.calls[0]);
    expect(sql).toContain('content_index');
    expect(sql).toContain('bool_or');
    expect(call).toContain(CLASSROOM);
    expect(call).toContain('"live"');
    expect(call).toContain('"deck"');
    expect(call).not.toContain('"draft"');
    // No text is read to answer this.
    expect(getContentText).not.toHaveBeenCalled();
  });

  it('counts drafts for staff', async () => {
    asRole('TEACHER');
    linkRows({ pages: [[0, record('draft', { is_draft: true })]] });
    queryRaw.mockResolvedValue([{ docKind: 'page', docId: 'draft' }]);

    await expect(countStartableSourceMaterial(ARGS)).resolves.toEqual({
      configured: 1,
      startable: 1,
    });
  });
});

describe('normalizeSourceMaterial', () => {
  it('keeps order and collapses duplicates, first position wins', () => {
    expect(
      normalizeSourceMaterial([
        { kind: 'slide', id: 's1' },
        { kind: 'page', id: 'p1' },
        { kind: 'slide', id: 's1' },
      ])
    ).toEqual([
      { kind: 'slide', id: 's1' },
      { kind: 'page', id: 'p1' },
    ]);
  });

  it.each([
    ['a non-list', 'page:p1'],
    ['null', null],
    ['an unknown kind', [{ kind: 'file', id: 'x' }]],
    ['a non-string id', [{ kind: 'page', id: { not: '' } }]],
    ['an empty id', [{ kind: 'page', id: '' }]],
  ])('refuses %s as resource_not_found', (_l, input) => {
    const error = (() => {
      try {
        normalizeSourceMaterial(input);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ResourceLinkServiceError);
    expect((error as InstanceType<typeof ResourceLinkServiceError>).code).toBe(
      'resource_not_found'
    );
  });
});

describe('setQuizSourceMaterial', () => {
  const makeTx = () => ({
    page: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map(id => ({ id }))
      ),
    },
    slide: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map(id => ({ id }))
      ),
    },
    pageLink: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    slideLink: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  });

  it('replaces the quiz’s links with the list, order = position across both kinds', async () => {
    const tx = makeTx();
    await setQuizSourceMaterial(tx as never, {
      quizId: 'quiz-1',
      classroomId: CLASSROOM,
      material: [
        { kind: 'page', id: 'p1' },
        { kind: 'slide', id: 's1' },
        { kind: 'page', id: 'p2' },
      ],
    });

    expect(tx.page.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2'] }, classroom_id: CLASSROOM },
      select: { id: true },
    });
    // Only a reveal.js deck can be material: FILE and LINK slides have no text.
    expect(tx.slide.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] }, classroom_id: CLASSROOM, kind: 'DECK' },
      select: { id: true },
    });
    expect(tx.pageLink.deleteMany).toHaveBeenCalledWith({ where: { quiz_id: 'quiz-1' } });
    expect(tx.slideLink.deleteMany).toHaveBeenCalledWith({ where: { quiz_id: 'quiz-1' } });
    expect(tx.pageLink.createMany).toHaveBeenCalledWith({
      data: [
        { page_id: 'p1', quiz_id: 'quiz-1', order: 0 },
        { page_id: 'p2', quiz_id: 'quiz-1', order: 2 },
      ],
    });
    expect(tx.slideLink.createMany).toHaveBeenCalledWith({
      data: [{ slide_id: 's1', quiz_id: 'quiz-1', order: 1 }],
    });
  });

  it('clears the material for an empty list', async () => {
    const tx = makeTx();
    await setQuizSourceMaterial(tx as never, {
      quizId: 'quiz-1',
      classroomId: CLASSROOM,
      material: [],
    });

    expect(tx.pageLink.deleteMany).toHaveBeenCalledOnce();
    expect(tx.slideLink.deleteMany).toHaveBeenCalledOnce();
    expect(tx.pageLink.createMany).not.toHaveBeenCalled();
    expect(tx.slideLink.createMany).not.toHaveBeenCalled();
  });

  it('refuses a document from another classroom BEFORE deleting anything', async () => {
    const tx = makeTx();
    tx.slide.findMany.mockResolvedValue([]);

    const error = await setQuizSourceMaterial(tx as never, {
      quizId: 'quiz-1',
      classroomId: CLASSROOM,
      material: [{ kind: 'slide', id: 'foreign' }],
    }).catch(e => e);

    expect(error).toBeInstanceOf(ResourceLinkServiceError);
    expect(tx.pageLink.deleteMany).not.toHaveBeenCalled();
    expect(tx.slideLink.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a FILE or LINK slide as resource_not_found BEFORE deleting anything', async () => {
    const tx = makeTx();
    // The classroom has a deck and a FILE slide; the kind filter admits the deck only.
    const kinds: Record<string, string> = { deck: 'DECK', pdf: 'FILE' };
    tx.slide.findMany.mockImplementation(
      async ({ where }: { where: { id: { in: string[] }; kind?: string } }) =>
        where.id.in.filter(id => !where.kind || kinds[id] === where.kind).map(id => ({ id }))
    );

    const error = await setQuizSourceMaterial(tx as never, {
      quizId: 'quiz-1',
      classroomId: CLASSROOM,
      material: [
        { kind: 'slide', id: 'deck' },
        { kind: 'slide', id: 'pdf' },
      ],
    }).catch(e => e);

    expect(error).toBeInstanceOf(ResourceLinkServiceError);
    expect((error as InstanceType<typeof ResourceLinkServiceError>).code).toBe(
      'resource_not_found'
    );
    expect(tx.pageLink.deleteMany).not.toHaveBeenCalled();
    expect(tx.slideLink.deleteMany).not.toHaveBeenCalled();
    expect(tx.slideLink.createMany).not.toHaveBeenCalled();
  });
});

describe('sourceMaterialOf', () => {
  const quiz = {
    classroom_id: CLASSROOM,
    page_links: [
      { order: 1, created_at: T0, page: { ...record('p1'), classroom_id: CLASSROOM } },
      {
        order: 2,
        created_at: T0,
        page: { ...record('draft', { is_draft: true }), classroom_id: CLASSROOM },
      },
      { order: 3, created_at: T0, page: { ...record('foreign'), classroom_id: 'classroom-2' } },
    ],
    slide_links: [
      { order: 0, created_at: T0, slide: { ...record('s0'), classroom_id: CLASSROOM } },
    ],
  };

  it('folds both relations into one ordered list and drops another classroom’s document', () => {
    expect(sourceMaterialOf(quiz)).toEqual([
      { kind: 'slide', id: 's0', title: 'Doc s0', is_draft: false, order: 0 },
      { kind: 'page', id: 'p1', title: 'Doc p1', is_draft: false, order: 1 },
      { kind: 'page', id: 'draft', title: 'Doc draft', is_draft: true, order: 2 },
    ]);
  });

  it('drops drafts for the student view', () => {
    expect(sourceMaterialOf(quiz, { publishedOnly: true }).map(d => d.id)).toEqual(['s0', 'p1']);
  });
});

describe('listSourceMaterialOptions', () => {
  it('offers every page and only reveal.js decks (FILE and LINK slides have no indexed text)', async () => {
    pageFindMany.mockResolvedValue([record('p')]);
    slideFindMany.mockResolvedValue([record('s')]);

    await expect(listSourceMaterialOptions(CLASSROOM)).resolves.toEqual({
      pages: [record('p')],
      decks: [record('s')],
    });
    expect(slideFindMany.mock.calls[0][0].where).toEqual({ classroom_id: CLASSROOM, kind: 'DECK' });
    expect(pageFindMany.mock.calls[0][0].where).toEqual({ classroom_id: CLASSROOM });
  });
});
