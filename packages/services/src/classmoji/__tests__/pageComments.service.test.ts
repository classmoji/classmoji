/**
 * pageComments.service's pure rules: who may read and write (every role ×
 * invite state × draft × classroom status), which threads a reader sees,
 * what a write may contain (body, quote, emoji), thread order, counts, the
 * wire shape and the audit row. Writes refused before any query are checked
 * with Prisma mocked to fail if touched.
 *
 * The real-database behaviour (user A vs B, classroom X vs Y, cascades) is
 * in pageComments.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassroomStatus, Role } from '@prisma/client';

// eslint-disable-next-line import/no-unresolved -- workspace package (it depends on this one)
import { canEnterClassroom, canMutateClassroom } from '@classmoji/auth/predicates';

const db = vi.hoisted(() => ({ touched: vi.fn() }));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () =>
    new Proxy(
      {},
      {
        get: (_target, model) => {
          db.touched(model);
          throw new Error(`Prisma touched: ${String(model)}`);
        },
      }
    ),
}));

const comments = await import('../pageComments.service.ts');
const { sectionViewerFromMemberships, NO_SECTION_VIEWER } =
  await import('../pageSections.service.ts');
const {
  PageCommentsForbiddenError,
  PageCommentsNotFoundError,
  PageCommentsValidationError,
  commentAccess,
  commentContext,
  threadVisible,
  cleanCommentBody,
  isValidReactionEmoji,
  resolveCommentAnchor,
  sortThreads,
  countOpenThreads,
  toThreadDto,
  groupReactions,
  badgeForRole,
  commentAuditRow,
} = comments;

beforeEach(() => db.touched.mockClear());

const ROLES: Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];
const STATUSES: ClassroomStatus[] = ['ACTIVE', 'LOCKED', 'UNPUBLISHED'];

const viewerOf = (role: Role | null, accepted = true) =>
  role
    ? sectionViewerFromMemberships([{ role, has_accepted_invite: accepted }])
    : NO_SECTION_VIEWER;

// ── Fixtures ───────────────────────────────────────────────────────────────

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const p = (id: string, value = id, children: unknown[] = []) => ({
  id,
  type: 'paragraph',
  props: {},
  content: text(value),
  children,
});
const locked = (id: string, title: string, children: unknown[]) => ({
  id,
  type: 'lockedSection',
  props: { title },
  children,
});

const DOC = [
  p('intro', 'Welcome to the   lab. Read the lab notes.'),
  locked('L1', 'Solution', [p('L1-body', 'The answer is 42.')]),
  locked('L2', 'Hint', [p('L2-body', 'Try recursion.')]),
  p('outro', 'Good luck'),
];

const PAGE = { id: 'page-1', classroom_id: 'class-x', is_draft: false };
const ACTIVE = { status: 'ACTIVE' as const };

const ctxFor = (
  role: Role | null,
  {
    accepted = true,
    unlocked = [] as string[],
    status = 'ACTIVE' as ClassroomStatus,
    page = PAGE,
    blocks = DOC as unknown,
  } = {}
) =>
  commentContext({
    userId: 'user-a',
    viewer: viewerOf(role, accepted),
    page,
    classroom: { status },
    blocks,
    unlockedSectionIds: unlocked,
  });

// ── Access ─────────────────────────────────────────────────────────────────

describe('classroom status predicates', () => {
  it('mirror @classmoji/auth/predicates exactly', () => {
    for (const status of STATUSES) {
      for (const role of ROLES) {
        expect(comments.canEnterClassroomStatus({ status, role })).toBe(
          canEnterClassroom({ status, role })
        );
        expect(comments.canMutateClassroomStatus({ status, role })).toBe(
          canMutateClassroom({ status, role })
        );
      }
    }
  });
});

describe('commentAccess', () => {
  const access = (
    role: Role | null,
    { accepted = true, draft = false, status = 'ACTIVE' as string } = {}
  ) =>
    commentAccess({
      viewer: viewerOf(role, accepted),
      page: { is_draft: draft },
      classroom: { status },
    });

  it('accepted members of an ACTIVE classroom read and write; staff resolve; owner/teacher moderate', () => {
    expect(access('OWNER')).toEqual({
      canRead: true,
      canWrite: true,
      canResolve: true,
      canModerate: true,
      frozen: false,
      role: 'OWNER',
    });
    expect(access('TEACHER')).toMatchObject({
      canWrite: true,
      canResolve: true,
      canModerate: true,
    });
    expect(access('ASSISTANT')).toMatchObject({
      canWrite: true,
      canResolve: true,
      canModerate: false,
    });
    expect(access('STUDENT')).toMatchObject({
      canRead: true,
      canWrite: true,
      canResolve: false,
      canModerate: false,
      role: 'STUDENT',
    });
  });

  it('non-members and pending invites (any role) get nothing', () => {
    expect(access(null)).toEqual(comments.NO_COMMENT_ACCESS);
    for (const role of ROLES) {
      expect(access(role, { accepted: false })).toEqual(comments.NO_COMMENT_ACCESS);
    }
  });

  it('a pending staff invite on top of an accepted student role stays a student', () => {
    const viewer = sectionViewerFromMemberships([
      { role: 'STUDENT', has_accepted_invite: true },
      { role: 'TEACHER', has_accepted_invite: false },
    ]);
    expect(commentAccess({ viewer, page: { is_draft: false }, classroom: ACTIVE })).toMatchObject({
      canRead: true,
      canResolve: false,
      canModerate: false,
      role: 'STUDENT',
    });
  });

  it('an accepted student with a PENDING teacher invite reads and writes on a draft page', () => {
    // Pinned on purpose: it mirrors the pages loader, which already shows this
    // user draft pages (`canViewDrafts` reads the role in any invite state).
    // Membership is still the ACCEPTED role, so they act as a student.
    const viewer = sectionViewerFromMemberships([
      { role: 'STUDENT', has_accepted_invite: true },
      { role: 'TEACHER', has_accepted_invite: false },
    ]);
    expect(commentAccess({ viewer, page: { is_draft: true }, classroom: ACTIVE })).toEqual({
      canRead: true,
      canWrite: true,
      canResolve: false,
      canModerate: false,
      frozen: false,
      role: 'STUDENT',
    });
  });

  it('draft pages: only canViewDrafts viewers (and accepted)', () => {
    expect(access('STUDENT', { draft: true }).canRead).toBe(false);
    expect(access('ASSISTANT', { draft: true }).canRead).toBe(true);
    expect(access('TEACHER', { draft: true }).canRead).toBe(true);
    expect(access('OWNER', { draft: true }).canRead).toBe(true);
    // A pending teacher may open drafts in the pages app, but is no member here.
    expect(access('TEACHER', { draft: true, accepted: false }).canRead).toBe(false);
    // A page row without is_draft is treated as a draft (fail closed).
    expect(
      commentAccess({
        viewer: viewerOf('STUDENT'),
        page: {} as { is_draft: boolean },
        classroom: ACTIVE,
      }).canRead
    ).toBe(false);
  });

  it('UNPUBLISHED admits only the owner; LOCKED is read-only except for the owner', () => {
    for (const role of ROLES) {
      const unpublished = access(role, { status: 'UNPUBLISHED' });
      const lockedAccess = access(role, { status: 'LOCKED' });
      if (role === 'OWNER') {
        expect(unpublished).toMatchObject({ canRead: true, canWrite: true, frozen: false });
        expect(lockedAccess).toMatchObject({ canRead: true, canWrite: true, frozen: false });
      } else {
        expect(unpublished).toEqual(comments.NO_COMMENT_ACCESS);
        expect(lockedAccess).toEqual({
          canRead: true,
          canWrite: false,
          canResolve: false,
          canModerate: false,
          frozen: true,
          role,
        });
      }
    }
  });

  it('an unknown or missing status admits nobody', () => {
    expect(access('OWNER', { status: 'ARCHIVED' })).toEqual(comments.NO_COMMENT_ACCESS);
    expect(
      commentAccess({
        viewer: viewerOf('OWNER'),
        page: { is_draft: false },
        classroom: {} as { status: string },
      })
    ).toEqual(comments.NO_COMMENT_ACCESS);
  });
});

// ── Visibility ─────────────────────────────────────────────────────────────

describe('threadVisible and commentContext', () => {
  const thread = (block_id: string | null, locked_section_id: string | null = null) => ({
    block_id,
    locked_section_id,
  });

  it('a student sees public blocks and the locked titles, not locked bodies', () => {
    const { filter, blockOrder } = ctxFor('STUDENT');
    expect(blockOrder).toEqual(['intro', 'L1', 'L2', 'outro']);
    expect(threadVisible(thread('intro'), filter)).toBe(true);
    expect(threadVisible(thread('L1'), filter)).toBe(true);
    expect(threadVisible(thread('L1-body', 'L1'), filter)).toBe(false);
    expect(threadVisible(thread(null), filter)).toBe(true);
  });

  it('unlocking a section shows its threads; other sections stay hidden', () => {
    const { filter, blockOrder } = ctxFor('STUDENT', { unlocked: ['L1'] });
    expect(blockOrder).toEqual(['intro', 'L1', 'L1-body', 'L2', 'outro']);
    expect(threadVisible(thread('L1-body', 'L1'), filter)).toBe(true);
    expect(threadVisible(thread('L2-body', 'L2'), filter)).toBe(false);
  });

  it('an unreadable document shows a reader page-level threads only (fail closed)', () => {
    const student = ctxFor('STUDENT', { blocks: null }).filter;
    expect(student.documentUnknown).toBe(true);
    // A block thread can't be placed: it might sit in a locked body.
    expect(threadVisible(thread('intro'), student)).toBe(false);
    expect(threadVisible(thread('deleted-block'), student)).toBe(false);
    expect(threadVisible(thread(null), student)).toBe(true);
    // The teaching team sees every body anyway.
    const assistant = ctxFor('ASSISTANT', { blocks: null }).filter;
    expect(threadVisible(thread('intro'), assistant)).toBe(true);
    // A document read and EMPTY (a legacy page) is known: orphans follow D2.
    const empty = ctxFor('STUDENT', { blocks: [] }).filter;
    expect(empty.documentUnknown).toBe(false);
    expect(threadVisible(thread('deleted-block'), empty)).toBe(true);
  });

  it('a thread on a deleted block stays gated by its locked section', () => {
    const student = ctxFor('STUDENT').filter;
    const unlockedStudent = ctxFor('STUDENT', { unlocked: ['L1'] }).filter;
    const assistant = ctxFor('ASSISTANT').filter;
    const gone = thread('deleted-block', 'L1');
    expect(threadVisible(gone, student)).toBe(false);
    expect(threadVisible(gone, unlockedStudent)).toBe(true);
    expect(threadVisible(gone, assistant)).toBe(true);
    // A deleted PUBLIC block: an orphan everyone sees.
    expect(threadVisible(thread('deleted-public'), student)).toBe(true);
    // Its whole locked section deleted: still gated on the stored id.
    expect(threadVisible(thread('gone', 'L-deleted'), student)).toBe(false);
  });

  it('staff (revealAll) see every body', () => {
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT'] as Role[]) {
      const { filter, readerBlocks } = ctxFor(role);
      expect(readerBlocks).toBe(DOC);
      expect(threadVisible(thread('L2-body', 'L2'), filter)).toBe(true);
    }
  });

  it('a non-array document reads as empty (page-level threads only)', () => {
    const ctx = ctxFor('STUDENT', { blocks: '<html>' });
    expect(ctx.fullBlocks).toEqual([]);
    expect(ctx.blockOrder).toEqual([]);
    expect(threadVisible(thread(null), ctx.filter)).toBe(true);
  });
});

// ── Validation ─────────────────────────────────────────────────────────────

const expectValidation = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PageCommentsValidationError);
    expect((error as InstanceType<typeof PageCommentsValidationError>).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe('cleanCommentBody', () => {
  it('normalizes line endings, drops NUL, trims', () => {
    expect(cleanCommentBody('  hi\r\nthere\rnow\u0000  ')).toBe('hi\nthere\nnow');
  });

  it('1 to 4000 characters', () => {
    expect(cleanCommentBody('x')).toBe('x');
    expect(cleanCommentBody('x'.repeat(4000))).toHaveLength(4000);
    expectValidation(() => cleanCommentBody('x'.repeat(4001)), 'INVALID_BODY');
    expectValidation(() => cleanCommentBody('   \r\n '), 'INVALID_BODY');
    expectValidation(() => cleanCommentBody(''), 'INVALID_BODY');
  });

  it('refuses non-strings', () => {
    for (const value of [undefined, null, 42, {}, ['x']]) {
      expectValidation(() => cleanCommentBody(value), 'INVALID_BODY');
    }
  });

  it('keeps markup as text', () => {
    expect(cleanCommentBody('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });
});

describe('isValidReactionEmoji', () => {
  it.each([
    ['👍'],
    ['❤️'],
    ['😀'],
    ['👍🏽'],
    ['👨‍👩‍👧‍👦'],
    ['🧑🏽‍🚀'],
    ['🏳️‍🌈'],
    ['❤️‍🔥'],
    ['🇺🇸'],
    ['🇯🇵'],
    ['1️⃣'],
    ['#️⃣'],
    ['🏴󠁧󠁢󠁳󠁣󠁴󠁿'],
    // Text-style symbols in their emoji form (VS16 or a skin tone).
    ['©️'],
    ['™️'],
    ['☝🏽'],
    ['♀️'],
    ['👁️‍🗨️'],
    ['🧑‍⚕️'],
    // Minimally qualified: one emoji-default part makes the sequence an emoji.
    ['🏳‍🌈'],
  ])('accepts %s', emoji => {
    expect(isValidReactionEmoji(emoji)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['text', 'a'],
    ['word', 'lol'],
    ['digit', '1'],
    ['hash', '#'],
    ['two emoji', '😀😀'],
    ['emoji then text', '😀a'],
    ['text then emoji', 'a😀'],
    ['trailing ZWJ', '😀‍'],
    ['leading ZWJ', '‍😀'],
    ['ZWJ to text', '😀‍a'],
    ['text ZWJ emoji', 'a‍😀'],
    ['double ZWJ', '😀‍‍😀'],
    ['combining mark', '😀́'],
    ['lone regional indicator', '🇺'],
    ['three regional indicators', '🇺🇸🇺'],
    ['skin tone alone', '🏽'],
    ['variation selector alone', '️'],
    ['zero-width space', '​'],
    ['tags without black flag', '😀\u{E0067}\u{E0062}\u{E007F}'],
    ['html', '<b>'],
    ['whitespace around', ' 👍 '],
    ['newline', '👍\n'],
    ['too long ZWJ chain', Array(12).fill('😀').join('‍')],
    // Text by default, with no VS16 or skin tone: shown as text, not emoji.
    ['copyright as text', '©'],
    ['registered as text', '®'],
    ['trademark as text', '™'],
    ['pointing finger as text', '☝'],
    ['female sign as text', '♀'],
    ['text-style ZWJ pair', '©‍©'],
    ['digit with VS16, no keycap', '1️'],
    ['unassigned pictographic code point', '\u{1FC00}'],
  ])('refuses %s', (_label, value) => {
    expect(isValidReactionEmoji(value)).toBe(false);
  });

  it('refuses non-strings', () => {
    for (const value of [undefined, null, 1, {}, ['👍']]) {
      expect(isValidReactionEmoji(value)).toBe(false);
    }
  });
});

describe('resolveCommentAnchor', () => {
  const student = ctxFor('STUDENT');
  const anchor = (input: Record<string, unknown>, ctx = student) =>
    resolveCommentAnchor({
      readerBlocks: ctx.readerBlocks,
      fullBlocks: ctx.fullBlocks,
      ...input,
    });

  it('page-level: no block, no quote', () => {
    expect(anchor({})).toEqual({
      blockId: null,
      quote: null,
      quoteOccurrence: 0,
      lockedSectionId: null,
    });
    expect(anchor({ blockId: null, quote: '' })).toMatchObject({ blockId: null });
    expectValidation(() => anchor({ quote: 'lab' }), 'INVALID_QUOTE');
    expectValidation(() => anchor({ quoteOccurrence: 1 }), 'INVALID_QUOTE');
  });

  it("a block must be in the reader's tree", () => {
    expect(anchor({ blockId: 'intro' })).toMatchObject({ blockId: 'intro', quote: null });
    expect(anchor({ blockId: 'L1' })).toMatchObject({ blockId: 'L1', lockedSectionId: null });
    expectValidation(() => anchor({ blockId: 'L1-body' }), 'INVALID_BLOCK');
    expectValidation(() => anchor({ blockId: 'nope' }), 'INVALID_BLOCK');
    expectValidation(() => anchor({ blockId: 'has space' }), 'INVALID_BLOCK');
    expectValidation(() => anchor({ blockId: 42 }), 'INVALID_BLOCK');
  });

  it('records the enclosing locked section from the full document', () => {
    expect(anchor({ blockId: 'L1-body' }, ctxFor('STUDENT', { unlocked: ['L1'] }))).toMatchObject({
      blockId: 'L1-body',
      lockedSectionId: 'L1',
    });
    expect(anchor({ blockId: 'L2-body' }, ctxFor('OWNER'))).toMatchObject({
      lockedSectionId: 'L2',
    });
  });

  it('a quote must occur (whitespace-normalized) at the given occurrence', () => {
    expect(anchor({ blockId: 'intro', quote: '  the \n lab. ' })).toEqual({
      blockId: 'intro',
      quote: 'the lab.',
      quoteOccurrence: 0,
      lockedSectionId: null,
    });
    expect(anchor({ blockId: 'intro', quote: 'lab', quoteOccurrence: 1 })).toMatchObject({
      quote: 'lab',
      quoteOccurrence: 1,
    });
    expectValidation(
      () => anchor({ blockId: 'intro', quote: 'lab', quoteOccurrence: 2 }),
      'INVALID_QUOTE'
    );
    expectValidation(() => anchor({ blockId: 'intro', quote: 'Good luck' }), 'INVALID_QUOTE');
    // The quote is matched in the block's OWN text, not elsewhere on the page.
    expectValidation(() => anchor({ blockId: 'outro', quote: 'lab' }), 'INVALID_QUOTE');
    // A locked section's text is its (public) title.
    expect(anchor({ blockId: 'L1', quote: 'Solution' })).toMatchObject({ quote: 'Solution' });
  });

  it('refuses a quote of a locked body to a reader without it', () => {
    // The reader can name the title block but not quote its hidden body.
    expectValidation(() => anchor({ blockId: 'L1', quote: '42' }), 'INVALID_QUOTE');
  });

  it('quote length, type and occurrence shape', () => {
    const long = { blockId: 'intro', quote: 'x'.repeat(501) };
    expectValidation(() => anchor(long), 'INVALID_QUOTE');
    expectValidation(() => anchor({ blockId: 'intro', quote: '   ' }), 'INVALID_QUOTE');
    expectValidation(() => anchor({ blockId: 'intro', quote: 42 }), 'INVALID_QUOTE');
    for (const bad of [-1, 0.5, '0', 10_001, NaN]) {
      expectValidation(
        () => anchor({ blockId: 'intro', quote: 'lab', quoteOccurrence: bad }),
        'INVALID_QUOTE'
      );
    }
    expectValidation(() => anchor({ blockId: 'intro', quoteOccurrence: 1 }), 'INVALID_QUOTE');
  });
});

// ── Order, counts, wire shape ──────────────────────────────────────────────

const at = (minute: number) => new Date(Date.UTC(2026, 9, 29, 12, minute));

describe('sortThreads', () => {
  it('document order, then page-level, then orphans; oldest first within each', () => {
    const threads = [
      { id: 'orphan', block_id: 'deleted', created_at: at(0) },
      { id: 'page-2', block_id: null, created_at: at(5) },
      { id: 'outro', block_id: 'outro', created_at: at(1) },
      { id: 'intro-late', block_id: 'intro', created_at: at(9) },
      { id: 'page-1', block_id: null, created_at: at(2) },
      { id: 'intro-early', block_id: 'intro', created_at: at(3) },
      { id: 'L1', block_id: 'L1', created_at: at(4) },
    ];
    expect(sortThreads(threads, ['intro', 'L1', 'L2', 'outro']).map(t => t.id)).toEqual([
      'intro-early',
      'intro-late',
      'L1',
      'outro',
      'page-1',
      'page-2',
      'orphan',
    ]);
  });

  it('breaks time ties by id and never mutates its input', () => {
    const threads = Object.freeze([
      { id: 'b', block_id: null, created_at: at(1) },
      { id: 'a', block_id: null, created_at: at(1) },
    ]);
    expect(sortThreads(threads, []).map(t => t.id)).toEqual(['a', 'b']);
  });
});

describe('countOpenThreads', () => {
  it('counts open visible threads only, per block in the tree', () => {
    const { filter } = ctxFor('STUDENT');
    const rows = [
      { block_id: 'intro', locked_section_id: null, resolved_at: null },
      { block_id: 'intro', locked_section_id: null, resolved_at: null },
      { block_id: 'intro', locked_section_id: null, resolved_at: at(1) },
      { block_id: 'L1', locked_section_id: null, resolved_at: null },
      { block_id: 'L1-body', locked_section_id: 'L1', resolved_at: null },
      { block_id: 'gone', locked_section_id: 'L1', resolved_at: null },
      { block_id: 'gone-public', locked_section_id: null, resolved_at: null },
      { block_id: null, locked_section_id: null, resolved_at: null },
    ];
    expect(countOpenThreads(rows, filter)).toEqual({
      counts: { intro: 2, L1: 1 },
      pageLevel: 1,
      open: 5,
    });
  });
});

describe('wire shape', () => {
  const user = (id: string, name: string | null = `Name ${id}`) => ({
    id,
    name,
    image: `https://img/${id}.png`,
  });
  const row = {
    id: 'thread-1',
    page_id: 'page-1',
    classroom_id: 'class-x',
    block_id: 'intro',
    quote: 'lab',
    quote_occurrence: 1,
    locked_section_id: null,
    created_by_id: 'user-a',
    created_at: at(0),
    resolved_at: at(10),
    resolved_by_id: 'user-ta',
    resolved_by: user('user-ta'),
    comments: [
      {
        id: 'c1',
        thread_id: 'thread-1',
        author_id: 'user-a',
        body: 'First',
        created_at: at(1),
        edited_at: at(2),
        author: user('user-a'),
        reactions: [
          { emoji: '👍', user_id: 'user-b' },
          { emoji: '🎉', user_id: 'user-a' },
          { emoji: '👍', user_id: 'user-a' },
        ],
      },
      {
        id: 'c2',
        thread_id: 'thread-1',
        author_id: 'user-b',
        body: 'Second',
        created_at: at(3),
        edited_at: null,
        author: user('user-b', null),
        reactions: [],
      },
      {
        id: 'c3',
        thread_id: 'thread-1',
        author_id: null,
        body: 'From a deleted user',
        created_at: at(4),
        edited_at: null,
        author: null,
        reactions: [],
      },
    ],
  };
  const badges = new Map([
    ['user-ta', 'TA' as const],
    ['user-a', null],
  ]);

  it('maps a row to the contract, with ISO dates and no ids, emails or logins of people', () => {
    const dto = toThreadDto(row, {
      viewerUserId: 'user-a',
      access: { canWrite: true, canModerate: false },
      badges,
    });
    expect(dto).toEqual({
      id: 'thread-1',
      blockId: 'intro',
      quote: 'lab',
      quoteOccurrence: 1,
      resolvedAt: at(10).toISOString(),
      resolvedBy: { name: 'Name user-ta', image: 'https://img/user-ta.png', badge: 'TA' },
      createdAt: at(0).toISOString(),
      comments: [
        {
          id: 'c1',
          author: { name: 'Name user-a', image: 'https://img/user-a.png', badge: null },
          body: 'First',
          createdAt: at(1).toISOString(),
          editedAt: at(2).toISOString(),
          reactions: [
            { emoji: '👍', count: 2, mine: true },
            { emoji: '🎉', count: 1, mine: true },
          ],
          canEdit: true,
          canDelete: true,
        },
        {
          id: 'c2',
          author: { name: comments.UNNAMED_AUTHOR, image: 'https://img/user-b.png', badge: null },
          body: 'Second',
          createdAt: at(3).toISOString(),
          editedAt: null,
          reactions: [],
          canEdit: false,
          canDelete: false,
        },
        {
          id: 'c3',
          author: null,
          body: 'From a deleted user',
          createdAt: at(4).toISOString(),
          editedAt: null,
          reactions: [],
          canEdit: false,
          canDelete: false,
        },
      ],
    });
    const json = JSON.stringify(dto);
    for (const id of ['user-a', 'user-b', 'user-ta', 'class-x', 'page-1']) {
      expect(json).not.toContain(`"${id}"`);
    }
  });

  it('moderators may delete every comment; a frozen viewer may do nothing', () => {
    const moderator = toThreadDto(row, {
      viewerUserId: 'user-owner',
      access: { canWrite: true, canModerate: true },
      badges,
    });
    expect(moderator.comments.map(c => [c.canEdit, c.canDelete])).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    const frozen = toThreadDto(row, {
      viewerUserId: 'user-a',
      access: { canWrite: false, canModerate: false },
      badges,
    });
    expect(frozen.comments.every(c => !c.canEdit && !c.canDelete)).toBe(true);
  });

  it('badges and reaction grouping', () => {
    expect(badgeForRole('OWNER')).toBe('Instructor');
    expect(badgeForRole('TEACHER')).toBe('Instructor');
    expect(badgeForRole('ASSISTANT')).toBe('TA');
    expect(badgeForRole('STUDENT')).toBeNull();
    expect(badgeForRole(null)).toBeNull();
    expect(groupReactions([], 'u')).toEqual([]);
    expect(
      groupReactions(
        [
          { emoji: '🎉', user_id: 'x' },
          { emoji: '🎉', user_id: 'y' },
        ],
        'u'
      )
    ).toEqual([{ emoji: '🎉', count: 2, mine: false }]);
  });
});

// ── Audit ──────────────────────────────────────────────────────────────────

describe('commentAuditRow', () => {
  const ctx = ctxFor('TEACHER');

  it('one shape for web and MCP: page resource, tool, ids and lengths only', () => {
    const event = {
      tool: 'page_comment' as const,
      action: 'CREATE' as const,
      thread_id: 't1',
      comment_id: 'c1',
      new_thread: true,
      block_id: 'intro',
      quote_length: 3,
      body_length: 11,
    };
    const web = commentAuditRow({ ctx, event, via: 'web' });
    const mcp = commentAuditRow({ ctx, event, via: 'mcp' });
    expect(web).toEqual({
      user_id: 'user-a',
      classroom_id: 'class-x',
      role: 'TEACHER',
      resource_type: 'PAGES',
      resource_id: 'page-1',
      action: 'CREATE',
      data: {
        tool: 'page_comment',
        thread_id: 't1',
        comment_id: 'c1',
        new_thread: true,
        block_id: 'intro',
        quote_length: 3,
        body_length: 11,
        via: 'web',
        page_id: 'page-1',
      },
    });
    expect({ ...mcp, data: { ...mcp!.data, via: 'web' } }).toEqual(web);
  });

  it('moderated deletes, reactions, resolves; impersonation noted', () => {
    expect(
      commentAuditRow({
        ctx,
        via: 'mcp',
        impersonatedBy: 'admin-1',
        event: {
          tool: 'page_comment',
          action: 'DELETE',
          thread_id: 't1',
          comment_id: 'c1',
          thread_deleted: true,
          moderated: true,
          comment_author_id: 'user-b',
        },
      })
    ).toMatchObject({
      action: 'DELETE',
      data: { moderated: true, comment_author_id: 'user-b', impersonated_by: 'admin-1' },
    });
    expect(
      commentAuditRow({
        ctx,
        via: 'web',
        event: {
          tool: 'page_comment_reaction',
          action: 'DELETE',
          thread_id: 't1',
          comment_id: 'c1',
          emoji: '👍',
        },
      })
    ).toMatchObject({ action: 'DELETE', data: { tool: 'page_comment_reaction', emoji: '👍' } });
    expect(
      commentAuditRow({
        ctx,
        via: 'web',
        event: { tool: 'page_comment_thread', action: 'UPDATE', thread_id: 't1', resolved: false },
      })
    ).toMatchObject({ action: 'UPDATE', data: { tool: 'page_comment_thread', resolved: false } });
  });

  it('no row without an event or an accepted role', () => {
    expect(commentAuditRow({ ctx, event: null, via: 'web' })).toBeNull();
    const event = {
      tool: 'page_comment_thread' as const,
      action: 'UPDATE' as const,
      thread_id: 't',
      resolved: true,
    };
    expect(commentAuditRow({ ctx: ctxFor(null), event, via: 'web' })).toBeNull();
  });
});

// ── Writes refused before any query ────────────────────────────────────────

describe('writes refused up front', () => {
  const expectRejects = async (promise: Promise<unknown>, type: unknown, code?: string) => {
    const error = await promise.then(
      () => null,
      e => e
    );
    expect(error).toBeInstanceOf(type as never);
    if (code) expect((error as { code?: string }).code).toBe(code);
    expect(db.touched).not.toHaveBeenCalled();
  };

  it('non-readers get not found, for every write', async () => {
    for (const ctx of [
      ctxFor(null),
      ctxFor('STUDENT', { accepted: false }),
      ctxFor('STUDENT', { page: { ...PAGE, is_draft: true } }),
      ctxFor('TEACHER', { status: 'UNPUBLISHED' }),
    ]) {
      await expectRejects(comments.createThread(ctx, { body: 'x' }), PageCommentsNotFoundError);
      await expectRejects(
        comments.reply(ctx, { threadId: 't', body: 'x' }),
        PageCommentsNotFoundError
      );
      await expectRejects(
        comments.setResolved(ctx, { threadId: 't', resolved: true }),
        PageCommentsNotFoundError
      );
      expect(await comments.listThreads(ctx)).toBeNull();
      expect(await comments.countsForViewer(ctx)).toBeNull();
    }
  });

  it('a LOCKED classroom refuses every write (CLASSROOM_LOCKED) but the owner', async () => {
    const ctx = ctxFor('TEACHER', { status: 'LOCKED' });
    const locked = (p: Promise<unknown>) =>
      expectRejects(p, PageCommentsForbiddenError, 'CLASSROOM_LOCKED');
    await locked(comments.createThread(ctx, { body: 'x' }));
    await locked(comments.reply(ctx, { threadId: 't', body: 'x' }));
    await locked(comments.editComment(ctx, { commentId: 'c', body: 'x' }));
    await locked(comments.deleteComment(ctx, { commentId: 'c' }));
    await locked(comments.setReaction(ctx, { commentId: 'c', emoji: '👍', on: true }));
    await locked(comments.setResolved(ctx, { threadId: 't', resolved: true }));
  });

  it('students may not resolve; bad input is a 400 before any query', async () => {
    await expectRejects(
      comments.setResolved(ctxFor('STUDENT'), { threadId: 't', resolved: true }),
      PageCommentsForbiddenError,
      'NOT_TEACHING_TEAM'
    );
    const ctx = ctxFor('STUDENT');
    await expectRejects(
      comments.createThread(ctx, { blockId: 'L1-body', body: 'x' }),
      PageCommentsValidationError,
      'INVALID_BLOCK'
    );
    await expectRejects(
      comments.createThread(ctx, { body: '' }),
      PageCommentsValidationError,
      'INVALID_BODY'
    );
    await expectRejects(
      comments.reply(ctx, { threadId: '', body: 'x' }),
      PageCommentsValidationError,
      'INVALID_ID'
    );
    await expectRejects(
      comments.setReaction(ctx, { commentId: 'c', emoji: 'lol', on: true }),
      PageCommentsValidationError,
      'INVALID_EMOJI'
    );
    await expectRejects(
      comments.setReaction(ctx, { commentId: 'c', emoji: '👍', on: 'yes' }),
      PageCommentsValidationError,
      'INVALID_VALUE'
    );
    await expectRejects(
      comments.setResolved(ctxFor('ASSISTANT'), { threadId: 't', resolved: 1 }),
      PageCommentsValidationError,
      'INVALID_VALUE'
    );
  });
});
