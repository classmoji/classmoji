/**
 * The feedback board over MCP: `feedback_read`, `feedback_write`,
 * `feedback_delete`.
 *
 * WHAT IS REAL HERE
 * -----------------
 * The REAL `feedback.service` runs against the schema-validating Prisma
 * stand-in, which answers from a small in-memory table set (it validates every
 * query against the schema; it does not execute writes). So "an anonymous
 * author never leaves" is a property of the service's own `publicPost` /
 * `publicComment` over rows that DO carry the author, as the database returns
 * them. Only the audit writer is mocked, to prove nothing calls it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import { resetRateLimits } from '../../mcp/rateLimit.ts';
import { toolAnnotations, type ToolContext, type ToolDefinition } from '../../mcp/registry.ts';

const USER_A = 'user-alice';
const USER_B = 'user-bob';

const mocks = vi.hoisted(() => {
  // Bob is a platform admin: the MCP must not care.
  process.env.PLATFORM_ADMIN_USER_IDS = 'user-bob';
  return { auditCreate: vi.fn() };
});

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', async () => {
  const feedback = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/feedback.service.ts')
  >('../../../../../packages/services/src/classmoji/feedback.service.ts');
  return {
    ...feedback,
    ClassmojiService: {
      feedback,
      audit: { create: (...args: unknown[]) => mocks.auditCreate(...args) },
    },
  };
});

const { feedbackReadTool, feedbackWriteTool, feedbackDeleteTool } = await import('../feedback.ts');
const { resetPrismaStub, setPrismaRows, prismaCallsFor } =
  await import('../../__tests__/prismaSchemaStub.ts');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const POST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Alice's, anonymous
const POST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Bob's, Completed
const COMMENT_A = 'cccccccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Alice's, anonymous, on POST_A
const COMMENT_B = 'cccccccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Bob's, on POST_A
const REPLY_A = 'dddddddd-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Alice's anonymous reply to COMMENT_B
const POST_PLANNED = 'abababab-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Alice's, anonymous, Planned
const MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NEW_POST = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const ALICE_NAME = 'Alice Hidden';
const authorRow = (id: string) => ({
  id,
  name: id === USER_A ? ALICE_NAME : 'Bob Visible',
  image: null,
});

type Row = Record<string, unknown>;

const at = new Date('2026-10-01T12:00:00.000Z');

const POSTS: Row[] = [
  {
    id: POST_A,
    title: 'Export grades to Canvas',
    body: 'Please let us export grades.',
    category: 'INTEGRATION',
    status: null,
    author_id: USER_A,
    is_anonymous: true,
    vote_count: 1,
    comment_count: 3,
    status_changed_at: null,
    created_at: at,
    updated_at: at,
  },
  {
    id: POST_B,
    title: 'Dark mode',
    body: 'Shipped already.',
    category: 'FEATURE',
    status: 'COMPLETED',
    author_id: USER_B,
    is_anonymous: false,
    vote_count: 7,
    comment_count: 0,
    status_changed_at: at,
    created_at: at,
    updated_at: at,
  },
];

/** On the roadmap, where the anonymity rule must hold too. */
const PLANNED_ANONYMOUS: Row = {
  id: POST_PLANNED,
  title: 'Quiet roadmap idea',
  body: 'Planned, and anonymous.',
  category: 'FEATURE',
  status: 'PLANNED',
  author_id: USER_A,
  is_anonymous: true,
  vote_count: 3,
  comment_count: 0,
  status_changed_at: at,
  created_at: at,
  updated_at: at,
};

const COMMENTS: Row[] = [
  {
    id: COMMENT_A,
    post_id: POST_A,
    parent_id: null,
    author_id: USER_A,
    is_anonymous: true,
    body: 'Quietly adding detail',
    vote_count: 1,
    created_at: at,
    updated_at: at,
  },
  {
    id: COMMENT_B,
    post_id: POST_A,
    parent_id: null,
    author_id: USER_B,
    is_anonymous: false,
    body: 'Me too',
    vote_count: 0,
    created_at: at,
    updated_at: at,
  },
  {
    id: REPLY_A,
    post_id: POST_A,
    parent_id: COMMENT_B,
    author_id: USER_A,
    is_anonymous: true,
    body: 'Thanks',
    vote_count: 0,
    created_at: at,
    updated_at: at,
  },
];

let votes: Row[] = [];
let commentVotes: Row[] = [];
let follows: Row[] = [];

/** Equality, `{ in }` and the compound unique keys the service uses. */
function matches(row: Row, where: Row | undefined): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === 'post_id_user_id' || key === 'comment_id_user_id') {
      if (!matches(row, value as Row)) return false;
      continue;
    }
    if (value && typeof value === 'object' && 'in' in (value as Row)) {
      if (!((value as { in: unknown[] }).in ?? []).includes(row[key])) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

const withAuthor = (row: Row) => ({
  ...row,
  author: row.author_id ? authorRow(String(row.author_id)) : null,
});

/** A post as `getPost`'s include returns it: comments, replies and every author. */
const postWithThread = (post: Row) => ({
  ...withAuthor(post),
  comments: COMMENTS.filter(c => c.post_id === post.id && c.parent_id === null).map(c => ({
    ...withAuthor(c),
    replies: COMMENTS.filter(r => r.parent_id === c.id).map(withAuthor),
  })),
});

function installDatabase(): void {
  setPrismaRows({
    feedbackPost: {
      findMany: () => POSTS.map(withAuthor),
      findUnique: (args: { where: Row }) => {
        const post = POSTS.find(p => matches(p, args.where));
        return post ? postWithThread(post) : null;
      },
      create: () => ({ id: NEW_POST }),
      update: () => ({ vote_count: 8 }),
      deleteMany: (args: { where: Row }) => ({
        count: POSTS.filter(p => matches(p, args.where)).length,
      }),
    },
    feedbackComment: {
      findUnique: (args: { where: Row }) => {
        const comment = COMMENTS.find(c => matches(c, args.where));
        if (!comment) return null;
        const replies = COMMENTS.filter(r => r.parent_id === comment.id).length;
        return { ...comment, _count: { replies } };
      },
      create: () => ({ id: 'new-comment' }),
      update: () => ({ vote_count: 2 }),
      deleteMany: (args: { where: Row }) => ({
        count: COMMENTS.filter(c => matches(c, args.where)).length,
      }),
    },
    feedbackVote: {
      findUnique: (args: { where: Row }) => votes.find(v => matches(v, args.where)) ?? null,
      findMany: (args: { where: Row }) => votes.filter(v => matches(v, args.where)),
    },
    feedbackCommentVote: {
      findUnique: (args: { where: Row }) => commentVotes.find(v => matches(v, args.where)) ?? null,
      findMany: (args: { where: Row }) => commentVotes.filter(v => matches(v, args.where)),
    },
    feedbackFollow: {
      findUnique: (args: { where: Row }) => follows.find(f => matches(f, args.where)) ?? null,
      deleteMany: (args: { where: Row }) => ({
        count: follows.filter(f => matches(f, args.where)).length,
      }),
    },
  });
}

const ctxFor = (userId: string): ToolContext =>
  ({
    viewer: { userId, clientId: 'c', scopes: new Set(['read', 'write']) },
  }) as unknown as ToolContext;

/** A tool's JSON answer, read loosely: the assertions name what they expect. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

const textOf = (result: { content: Array<{ text: string }> }) => result.content[0].text;

const call = async <A>(tool: ToolDefinition<A>, args: A, userId: string) => {
  const text = textOf((await tool.handler(args, ctxFor(userId))) as never);
  return { text, payload: JSON.parse(text) as Payload };
};

async function refusalOf(run: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the handler to refuse').toBeInstanceOf(ToolError);
  return (caught as ToolError).kind;
}

beforeEach(() => {
  resetPrismaStub();
  resetRateLimits();
  mocks.auditCreate.mockReset();
  votes = [
    { id: 'v1', post_id: POST_A, user_id: USER_A },
    { id: 'v2', post_id: POST_B, user_id: USER_B },
  ];
  commentVotes = [{ id: 'cv1', comment_id: COMMENT_A, user_id: USER_B }];
  follows = [
    { id: 'f1', post_id: POST_A, user_id: USER_A },
    { id: 'f2', post_id: POST_B, user_id: USER_B },
  ];
  installDatabase();
});

afterEach(() => {
  // No feedback tool ever writes an audit row (by decision, as on the web).
  expect(mocks.auditCreate).not.toHaveBeenCalled();
});

// ─── Definitions ────────────────────────────────────────────────────────────

describe('definitions', () => {
  const tools = [
    feedbackReadTool,
    feedbackWriteTool,
    feedbackDeleteTool,
  ] as ToolDefinition<never>[];

  it('are platform-wide (roles null) and described in under 1,500 bytes', () => {
    for (const tool of tools) {
      expect(tool.roles, tool.name).toBeNull();
      expect(tool.name.startsWith('feedback_')).toBe(true);
      expect(Buffer.byteLength(tool.description), tool.name).toBeLessThan(1500);
    }
  });

  it('annotate read as read-only, write as not destructive, delete as destructive', () => {
    const [read, write, del] = tools.map(toolAnnotations);
    expect(read).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(write).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(del).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(feedbackReadTool.scope).toBe('read');
    expect(feedbackWriteTool.scope).toBe('write');
    expect(feedbackDeleteTool.scope).toBe('write');
  });
});

// ─── feedback_read ──────────────────────────────────────────────────────────

describe('feedback_read', () => {
  it('searches every status (Completed included) and passes query and status through', async () => {
    const { payload } = await call(feedbackReadTool, { query: 'grades' }, USER_B);
    const [unfiltered] = prismaCallsFor('feedbackPost', 'findMany');
    const where = (unfiltered.args as { where: Row }).where;
    expect(where).not.toHaveProperty('status');
    expect(where).not.toHaveProperty('OR');
    expect(JSON.stringify(where)).not.toContain('COMPLETED');
    expect(JSON.stringify(where)).toContain('grades');
    expect(payload.posts.map((p: Row) => p.id)).toEqual([POST_A, POST_B]);

    resetPrismaStub();
    installDatabase();
    await call(feedbackReadTool, { view: 'search', status: 'PLANNED', sort: 'new' }, USER_B);
    const [filtered] = prismaCallsFor('feedbackPost', 'findMany');
    expect((filtered.args as { where: Row }).where).toMatchObject({ status: 'PLANNED' });
  });

  it('never shows Alice to Bob as the author of her anonymous post, in search', async () => {
    const { text, payload } = await call(feedbackReadTool, {}, USER_B);
    expect(text).not.toContain(USER_A);
    expect(text).not.toContain(ALICE_NAME);
    const [anon, own] = payload.posts;
    expect(anon).toMatchObject({ id: POST_A, author: null, is_anonymous: true });
    expect(anon).not.toHaveProperty('author_id');
    expect(anon).toMatchObject({ viewerVoted: false, viewerIsAuthor: false });
    expect(own).toMatchObject({ id: POST_B, author: 'Bob Visible', viewerVoted: true });
    expect(own.viewerIsAuthor).toBe(true);
    expect(own.url).toMatch(new RegExp(`/feedback/p/${POST_B}$`));
  });

  it('tells Alice her anonymous post is hers', async () => {
    const { payload } = await call(feedbackReadTool, {}, USER_A);
    expect(payload.posts[0]).toMatchObject({ id: POST_A, viewerIsAuthor: true, viewerVoted: true });
    expect(payload.posts[0].author).toBeNull();
  });

  it("never shows Alice to Bob in a post's thread", async () => {
    const { text, payload } = await call(
      feedbackReadTool,
      { view: 'post', post_id: POST_A },
      USER_B
    );
    expect(text).not.toContain(USER_A);
    expect(text).not.toContain(ALICE_NAME);
    expect(payload).toMatchObject({ id: POST_A, author: null, viewerIsAuthor: false });
    expect(payload.body).toBe('Please let us export grades.');
    const [anonComment, bobComment] = payload.comments;
    expect(anonComment).toMatchObject({
      id: COMMENT_A,
      author: null,
      viewerIsAuthor: false,
      viewerVoted: true,
    });
    expect(bobComment).toMatchObject({
      id: COMMENT_B,
      author: 'Bob Visible',
      viewerIsAuthor: true,
    });
    expect(bobComment.replies[0]).toMatchObject({
      id: REPLY_A,
      author: null,
      viewerIsAuthor: false,
    });
  });

  it("marks Alice's own anonymous comment and reply as hers", async () => {
    const { payload } = await call(feedbackReadTool, { view: 'post', post_id: POST_A }, USER_A);
    expect(payload.comments[0]).toMatchObject({ viewerIsAuthor: true, viewerVoted: false });
    expect(payload.comments[1].replies[0]).toMatchObject({ viewerIsAuthor: true });
  });

  it('answers not_found for a missing post, invalid_params without post_id', async () => {
    expect(
      await refusalOf(() =>
        feedbackReadTool.handler({ view: 'post', post_id: MISSING }, ctxFor(USER_B))
      )
    ).toBe('not_found');
    expect(await refusalOf(() => feedbackReadTool.handler({ view: 'post' }, ctxFor(USER_B)))).toBe(
      'invalid_params'
    );
  });

  it('groups the roadmap by status', async () => {
    const { payload } = await call(feedbackReadTool, { view: 'roadmap' }, USER_B);
    expect(payload.columns.COMPLETED.posts.map((p: Row) => p.id)).toEqual([POST_B]);
    expect(payload.columns.PLANNED).toEqual({ total: 0, posts: [] });
  });

  it('never shows Alice to Bob as the author of her anonymous post, on the roadmap', async () => {
    setPrismaRows({
      feedbackPost: { findMany: () => [...POSTS, PLANNED_ANONYMOUS].map(withAuthor) },
    });
    const { text, payload } = await call(feedbackReadTool, { view: 'roadmap' }, USER_B);
    expect(payload.columns.PLANNED.total).toBe(1);
    const [planned] = payload.columns.PLANNED.posts;
    expect(planned).toMatchObject({
      id: POST_PLANNED,
      author: null,
      is_anonymous: true,
      viewerIsAuthor: false,
    });
    expect(planned).not.toHaveProperty('author_id');
    expect(text).not.toContain(USER_A);
    expect(text).not.toContain(ALICE_NAME);
  });
});

// ─── feedback_write ─────────────────────────────────────────────────────────

describe('feedback_write', () => {
  it('files a post as the caller and returns its id', async () => {
    const { payload } = await call(
      feedbackWriteTool,
      { action: 'post', title: 'Calendar sync', body: 'With Google', anonymous: true },
      USER_A
    );
    expect(payload).toMatchObject({ post_id: NEW_POST });
    const [create] = prismaCallsFor('feedbackPost', 'create');
    expect((create.args as { data: Row }).data).toMatchObject({
      author_id: USER_A,
      is_anonymous: true,
      category: 'FEATURE',
    });
  });

  it('comments as the caller, never as an argument, under the parent, anonymously', async () => {
    const { payload } = await call(
      feedbackWriteTool,
      {
        action: 'comment',
        post_id: POST_A,
        parent_comment_id: COMMENT_B,
        body: 'Replying quietly',
        anonymous: true,
        // Not an argument the tool has: it must never pick the author.
        author_id: USER_B,
      } as never,
      USER_A
    );
    expect(payload).toEqual({
      comment_id: 'new-comment',
      post_id: POST_A,
      url: expect.stringMatching(new RegExp(`/feedback/p/${POST_A}$`)),
    });
    const [create] = prismaCallsFor('feedbackComment', 'create');
    expect((create.args as { data: Row }).data).toEqual({
      post_id: POST_A,
      author_id: USER_A,
      parent_id: COMMENT_B,
      body: 'Replying quietly',
      is_anonymous: true,
    });
    const [count] = prismaCallsFor('feedbackPost', 'update');
    expect((count.args as { where: Row }).where).toEqual({ id: POST_A });
  });

  it('sets a vote: the same vote twice writes nothing', async () => {
    const { payload } = await call(
      feedbackWriteTool,
      { action: 'vote', post_id: POST_A, voted: true },
      USER_A
    );
    expect(payload).toEqual({ post_id: POST_A, voted: true, vote_count: 1 });
    expect(prismaCallsFor('feedbackVote', 'createMany')).toHaveLength(0);
    expect(prismaCallsFor('feedbackPost', 'update')).toHaveLength(0);
  });

  it('adds a vote that was not there, as the caller, and follows', async () => {
    const { payload } = await call(
      feedbackWriteTool,
      { action: 'vote', post_id: POST_B, voted: true },
      USER_A
    );
    expect(payload).toEqual({ post_id: POST_B, voted: true, vote_count: 8 });
    const [create] = prismaCallsFor('feedbackVote', 'createMany');
    expect((create.args as { data: Row[] }).data).toEqual([{ post_id: POST_B, user_id: USER_A }]);
    expect(prismaCallsFor('feedbackFollow', 'createMany')).toHaveLength(1);
  });

  it('sets a comment vote and a follow', async () => {
    const vote = await call(
      feedbackWriteTool,
      { action: 'vote', comment_id: COMMENT_A, voted: true },
      USER_B
    );
    expect(vote.payload).toEqual({ comment_id: COMMENT_A, voted: true, vote_count: 1 });
    expect(prismaCallsFor('feedbackCommentVote', 'createMany')).toHaveLength(0);

    const follow = await call(
      feedbackWriteTool,
      { action: 'follow', post_id: POST_A, following: false },
      USER_A
    );
    expect(follow.payload).toEqual({ post_id: POST_A, following: false });
    const [unfollow] = prismaCallsFor('feedbackFollow', 'deleteMany');
    expect((unfollow.args as { where: Row }).where).toEqual({ post_id: POST_A, user_id: USER_A });
  });

  it('answers not_found for a vote on a missing post or comment', async () => {
    for (const args of [
      { action: 'vote' as const, post_id: MISSING, voted: false },
      { action: 'vote' as const, comment_id: MISSING, voted: false },
      { action: 'follow' as const, post_id: MISSING, following: false },
    ]) {
      expect(await refusalOf(() => feedbackWriteTool.handler(args, ctxFor(USER_A)))).toBe(
        'not_found'
      );
    }
  });

  it('refuses what an action is missing', async () => {
    const refusals = [
      { action: 'post', body: 'No title' },
      { action: 'post', title: 'No body' },
      { action: 'comment', body: 'No post' },
      { action: 'vote', voted: true },
      { action: 'vote', post_id: POST_A, comment_id: COMMENT_A, voted: true },
      { action: 'vote', post_id: POST_A },
      { action: 'follow', post_id: POST_A },
      { action: 'follow', following: true },
    ] as const;
    for (const args of refusals) {
      expect(
        await refusalOf(() => feedbackWriteTool.handler(args as never, ctxFor(USER_A))),
        JSON.stringify(args)
      ).toBe('invalid_params');
    }
  });

  it("maps the service's content rules to invalid_params", async () => {
    expect(
      await refusalOf(() =>
        feedbackWriteTool.handler(
          { action: 'post', title: 'x', body: 'Too short a title' },
          ctxFor(USER_A)
        )
      )
    ).toBe('invalid_params');
  });

  it('spends the post budget per action: the sixth post is refused, a vote still goes', async () => {
    for (let i = 0; i < 5; i++) {
      await call(feedbackWriteTool, { action: 'post', title: `Idea ${i}`, body: 'Body' }, USER_A);
    }
    expect(
      await refusalOf(() =>
        feedbackWriteTool.handler({ action: 'post', title: 'Idea 6', body: 'Body' }, ctxFor(USER_A))
      )
    ).toBe('rate_limited');
    const { payload } = await call(
      feedbackWriteTool,
      { action: 'vote', post_id: POST_B, voted: true },
      USER_A
    );
    expect(payload.voted).toBe(true);
    // Another user's budget is their own.
    await call(feedbackWriteTool, { action: 'post', title: 'Bob idea', body: 'Body' }, USER_B);
  });

  it("declares the registry's per-tool bucket as vote's burst at the default refill", () => {
    expect(feedbackWriteTool.rateLimit).toEqual({ capacity: 60, refillPerSecond: 0.5 });
  });

  it('refills each action budget at perHour / 3600 a second', async () => {
    // rateLimit.ts reads Date.now(); hold it still and move it by hand.
    let now = Date.parse('2026-10-20T12:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const post = (title: string) =>
      feedbackWriteTool.handler({ action: 'post', title, body: 'Body' }, ctxFor(USER_A));
    try {
      for (let i = 0; i < 5; i++) await post(`Idea ${i}`);
      expect(await refusalOf(() => post('Idea 6'))).toBe('rate_limited');

      // 10 an hour is one every 360 s: not yet at 359 s, exactly one at 360 s.
      now += 359_000;
      expect(await refusalOf(() => post('Too soon'))).toBe('rate_limited');
      now += 1_000;
      await post('One more');
      expect(await refusalOf(() => post('And another'))).toBe('rate_limited');
    } finally {
      clock.mockRestore();
    }
  });
});

// ─── feedback_delete ────────────────────────────────────────────────────────

describe('feedback_delete', () => {
  const nothingDeleted = () => {
    expect(prismaCallsFor('feedbackPost', 'deleteMany')).toHaveLength(0);
    expect(prismaCallsFor('feedbackComment', 'deleteMany')).toHaveLength(0);
  };

  it("refuses Bob, a platform admin, Alice's post and comment", async () => {
    expect(process.env.PLATFORM_ADMIN_USER_IDS).toContain(USER_B);
    expect(
      await refusalOf(() => feedbackDeleteTool.handler({ post_id: POST_A }, ctxFor(USER_B)))
    ).toBe('forbidden');
    expect(
      await refusalOf(() => feedbackDeleteTool.handler({ comment_id: COMMENT_A }, ctxFor(USER_B)))
    ).toBe('forbidden');
    nothingDeleted();
  });

  it("refuses Alice Bob's post and comment", async () => {
    expect(
      await refusalOf(() => feedbackDeleteTool.handler({ post_id: POST_B }, ctxFor(USER_A)))
    ).toBe('forbidden');
    expect(
      await refusalOf(() => feedbackDeleteTool.handler({ comment_id: COMMENT_B }, ctxFor(USER_A)))
    ).toBe('forbidden');
    nothingDeleted();
  });

  it('answers not_found for a missing post or comment, invalid_params for both or neither', async () => {
    expect(
      await refusalOf(() => feedbackDeleteTool.handler({ post_id: MISSING }, ctxFor(USER_A)))
    ).toBe('not_found');
    expect(
      await refusalOf(() => feedbackDeleteTool.handler({ comment_id: MISSING }, ctxFor(USER_A)))
    ).toBe('not_found');
    expect(
      await refusalOf(() =>
        feedbackDeleteTool.handler({ post_id: POST_A, comment_id: COMMENT_A }, ctxFor(USER_A))
      )
    ).toBe('invalid_params');
    expect(await refusalOf(() => feedbackDeleteTool.handler({}, ctxFor(USER_A)))).toBe(
      'invalid_params'
    );
    nothingDeleted();
  });

  it('lets Alice delete her own anonymous post and comment', async () => {
    expect((await call(feedbackDeleteTool, { post_id: POST_A }, USER_A)).payload).toEqual({
      deleted: 'post',
      post_id: POST_A,
    });
    const [deletePost] = prismaCallsFor('feedbackPost', 'deleteMany');
    expect((deletePost.args as { where: Row }).where).toEqual({ id: POST_A });

    await call(feedbackDeleteTool, { comment_id: COMMENT_A }, USER_A);
    const [deleteComment] = prismaCallsFor('feedbackComment', 'deleteMany');
    expect((deleteComment.args as { where: Row }).where).toEqual({ id: COMMENT_A });
  });

  it('answers not_found when a concurrent delete got there first', async () => {
    // The author check still finds the row; the delete then matches nothing.
    setPrismaRows({
      feedbackPost: { deleteMany: () => ({ count: 0 }) },
      feedbackComment: { deleteMany: () => ({ count: 0 }) },
    });
    expect(
      await refusalOf(() => feedbackDeleteTool.handler({ post_id: POST_A }, ctxFor(USER_A)))
    ).toBe('not_found');
    expect(
      await refusalOf(() => feedbackDeleteTool.handler({ comment_id: COMMENT_A }, ctxFor(USER_A)))
    ).toBe('not_found');
    // The comment count is left alone when no comment went.
    expect(prismaCallsFor('feedbackPost', 'update')).toHaveLength(0);
  });
});
