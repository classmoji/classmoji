import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import type { Prisma } from '@prisma/client';
import { ClassmojiService } from '@classmoji/services';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';

/**
 * The feedback board for the people who answer it: features, bugs and
 * questions, each with its own queue, and status changes and merges done in
 * place. Voter names and emails exist only here (the board and the MCP show
 * counts at most). Writes NO audit rows, here or anywhere (decided for #739).
 */
export const CATEGORIES = ['FEATURE', 'BUG', 'QUESTION'] as const;
export type Category = (typeof CATEGORIES)[number];

const CLOSED: Record<Category, string> = {
  FEATURE: 'COMPLETED',
  BUG: 'FIXED',
  QUESTION: 'ANSWERED',
};
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

const STATES = ['open', 'stale', 'closed', 'all'] as const;
type State = (typeof STATES)[number];

const stateWhere = (category: Category, state: State, now: Date): Prisma.FeedbackPostWhereInput => {
  const open = { OR: [{ status: null }, { status: { not: CLOSED[category] as never } }] };
  if (state === 'open') return open;
  if (state === 'closed') return { status: CLOSED[category] as never };
  if (state === 'stale') {
    const before = new Date(now.getTime() - STALE_MS);
    return {
      ...open,
      created_at: { lt: before },
      comments: { none: { created_at: { gte: before } } },
      updates: { none: { created_at: { gte: before } } },
    };
  }
  return {};
};

export async function loadFeedback({ request }: LoaderFunctionArgs) {
  const { user: admin } = await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const now = new Date();
  const catParam = (url.searchParams.get('category') ?? 'FEATURE').toUpperCase();
  const category: Category = (CATEGORIES as readonly string[]).includes(catParam)
    ? (catParam as Category)
    : 'FEATURE';
  const stateParam = url.searchParams.get('state') ?? 'open';
  const state: State = (STATES as readonly string[]).includes(stateParam)
    ? (stateParam as State)
    : 'open';
  const q = (url.searchParams.get('q') ?? '').trim();
  const postId = url.searchParams.get('post');
  const tab = url.searchParams.get('tab') === 'comments' ? 'comments' : 'voters';

  const search: Prisma.FeedbackPostWhereInput = q
    ? {
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { body: { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};
  const where: Prisma.FeedbackPostWhereInput = {
    AND: [{ category, duplicate_of_id: null }, stateWhere(category, state, now), search],
  };

  const [posts, categoryCounts, stateCounts, ranking] = await Promise.all([
    prisma.feedbackPost.findMany({
      where,
      orderBy:
        category === 'FEATURE'
          ? [{ vote_count: 'desc' }, { created_at: 'desc' }]
          : [{ created_at: 'desc' }],
      take: 200,
      select: {
        id: true,
        title: true,
        status: true,
        vote_count: true,
        comment_count: true,
        created_at: true,
        is_anonymous: true,
        author: { select: { id: true, name: true } },
        comments: { orderBy: { created_at: 'desc' }, take: 1, select: { created_at: true } },
        updates: { orderBy: { created_at: 'desc' }, take: 1, select: { created_at: true } },
      },
    }),
    Promise.all(
      CATEGORIES.map(c =>
        prisma.feedbackPost.count({
          where: { category: c, duplicate_of_id: null, ...stateWhere(c, 'open', now) },
        })
      )
    ),
    Promise.all(
      STATES.map(s =>
        prisma.feedbackPost.count({
          where: {
            AND: [{ category, duplicate_of_id: null }, stateWhere(category, s, now), search],
          },
        })
      )
    ),
    category === 'FEATURE' ? ClassmojiService.feedback.listFeatureRanking() : Promise.resolve([]),
  ]);
  const roles = new Map(ranking.map(r => [r.id, r.roles]));

  const selected = postId ? await ClassmojiService.feedback.getPost(postId, admin.id) : null;
  const [voters, mergeTargets] = selected
    ? await Promise.all([
        ClassmojiService.feedback.listFeatureVoters(selected.id),
        prisma.feedbackPost.findMany({
          where: {
            category: selected.category,
            duplicate_of_id: null,
            id: { not: selected.id },
          },
          orderBy: { vote_count: 'desc' },
          take: 100,
          select: { id: true, title: true, vote_count: true },
        }),
      ])
    : [null, []];

  return {
    category,
    state,
    query: q,
    tab,
    webappUrl: process.env.WEBAPP_URL ?? 'http://localhost:3000',
    statuses: ClassmojiService.feedback.FEEDBACK_STATUSES_BY_CATEGORY[
      category
    ] as readonly string[],
    statusLabels: ClassmojiService.feedback.FEEDBACK_STATUS_LABELS as Record<string, string>,
    categoryCounts: Object.fromEntries(CATEGORIES.map((c, i) => [c, categoryCounts[i]])) as Record<
      Category,
      number
    >,
    stateCounts: Object.fromEntries(STATES.map((s, i) => [s, stateCounts[i]])) as Record<
      State,
      number
    >,
    posts: posts.map(p => {
      const lastReply = [p.comments[0]?.created_at, p.updates[0]?.created_at]
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        id: p.id,
        title: p.title,
        status: p.status,
        votes: p.vote_count,
        comments: p.comment_count,
        createdAt: p.created_at.toISOString(),
        author: p.is_anonymous ? null : p.author,
        lastReplyAt: lastReply?.toISOString() ?? null,
        roles: roles.get(p.id) ?? null,
      };
    }),
    selected: selected
      ? {
          id: selected.id,
          title: selected.title,
          body: selected.body,
          category: selected.category,
          status: selected.status,
          createdAt: selected.created_at.toISOString(),
          author: selected.author as { id: string; name: string | null } | null,
          votes: selected.vote_count,
          bug: {
            whatHappened: selected.bug_what_happened,
            expected: selected.bug_expected,
            steps: selected.bug_steps,
          },
          comments: selected.comments.map(c => ({
            id: c.id,
            body: c.body,
            createdAt: c.created_at.toISOString(),
            author: c.author as { id: string; name: string | null } | null,
            maintainer: c.authorIsMaintainer,
            replies: c.replies.map(r => ({
              id: r.id,
              body: r.body,
              createdAt: r.created_at.toISOString(),
              author: r.author as { id: string; name: string | null } | null,
              maintainer: r.authorIsMaintainer,
            })),
          })),
          updates: selected.updates.map(u => ({
            note: u.note,
            to: u.to_status,
            createdAt: u.created_at.toISOString(),
          })),
        }
      : null,
    voters: voters?.map(v => ({ ...v, votedAt: v.votedAt.toISOString() })) ?? null,
    mergeTargets,
  };
}

/**
 * Status (with an optional public note, sent to followers by the service) and
 * merge. The admin gate runs here, before anything is written.
 */
export async function feedbackAction({ request }: ActionFunctionArgs) {
  const { user: admin } = await requirePlatformAdmin(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const postId = String(form.get('postId') ?? '');
  if (!postId) return { error: 'No post named.' };
  const svc = ClassmojiService.feedback;
  try {
    if (intent === 'status') {
      const raw = String(form.get('status') ?? '');
      const status = raw === '' ? null : raw;
      if (status !== null && !svc.isFeedbackStatus(status)) return { error: 'Unknown status.' };
      await svc.setStatus({
        postId,
        status,
        actorId: admin.id,
        note: String(form.get('note') ?? ''),
      });
      return { ok: true, message: 'Status saved.' };
    }
    if (intent === 'merge') {
      const originalId = String(form.get('originalId') ?? '');
      if (!originalId) return { error: 'Pick the post to merge into.' };
      const { originalId: into } = await svc.markDuplicate({
        postId,
        originalId,
        actorId: admin.id,
      });
      return { ok: true, message: 'Merged.', redirectTo: into };
    }
  } catch (error) {
    if (
      error instanceof svc.FeedbackValidationError ||
      error instanceof svc.FeedbackNotFoundError
    ) {
      return { error: error.message || 'That post no longer exists.' };
    }
    console.error('[admin] feedback action failed:', error);
    return { error: 'Could not save that. Try again.' };
  }
  return { error: 'Unknown action.' };
}
