/**
 * Every write on the feedback board, and its one public read.
 *
 * GET  /api/feedback?similar=<title>&type=<category>  posts like that title,
 *      for the "already posted?" box. Public fields only, like the board.
 * POST /api/feedback   form fields: intent + the ids/fields that intent needs
 *
 * Auth: a session for every write. Platform admins (PLATFORM_ADMIN_USER_IDS)
 * may also set a post's status (with a public note), merge duplicates, and
 * delete anyone's post or comment; everyone else may delete only their own.
 * The asker of a question may mark it answered.
 */

import { redirect } from 'react-router';
import { PLATFORM_ADMIN_USER_IDS, requireAuth } from '@classmoji/auth/server';
import {
  ClassmojiService,
  FeedbackNotFoundError,
  FeedbackValidationError,
  isFeedbackCategory,
  isFeedbackStatus,
} from '@classmoji/services';
import { allowFeedbackAction } from '~/utils/feedbackRate.server';
import type { Route } from './+types/route';

const feedback = ClassmojiService.feedback;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  const title = (url.searchParams.get('similar') ?? '').slice(0, 200);
  const type = url.searchParams.get('type')?.toUpperCase() ?? null;
  const posts = await feedback.findSimilarPosts({
    title,
    category: isFeedbackCategory(type) ? type : null,
  });
  return Response.json({ posts }, { headers: { 'Cache-Control': 'no-store' } });
};

const tooFast = () =>
  Response.json(
    { error: 'You are doing that a lot. Try again in a little while.' },
    { status: 429 }
  );

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const { userId } = await requireAuth(request);
  const isAdmin = PLATFORM_ADMIN_USER_IDS.includes(userId);
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  const intent = field('intent');

  try {
    switch (intent) {
      case 'create-post': {
        if (!allowFeedbackAction(userId, 'post')) return tooFast();
        // The web form always names a type: one picked by default is how
        // questions and bugs ended up filed as feature requests.
        const category = field('category');
        if (!isFeedbackCategory(category)) {
          return Response.json({ error: 'Pick what kind of post this is.' }, { status: 400 });
        }
        const { id } = await feedback.createPost({
          authorId: userId,
          title: field('title'),
          body: field('body'),
          // A bug from the form arrives as the Github template's fields.
          bug:
            category === 'BUG' && form.has('bug_what_happened')
              ? {
                  whatHappened: field('bug_what_happened'),
                  expected: field('bug_expected'),
                  steps: field('bug_steps'),
                  additionalInfo: field('bug_additional_info'),
                }
              : null,
          category,
          isAnonymous: field('anonymous') === 'true',
        });
        return { ok: true, postId: id };
      }
      case 'vote': {
        if (!allowFeedbackAction(userId, 'vote')) return tooFast();
        return { ok: true, ...(await feedback.togglePostVote(field('postId'), userId)) };
      }
      case 'comment-vote': {
        if (!allowFeedbackAction(userId, 'vote')) return tooFast();
        return { ok: true, ...(await feedback.toggleCommentVote(field('commentId'), userId)) };
      }
      case 'comment': {
        if (!allowFeedbackAction(userId, 'comment')) return tooFast();
        await feedback.addComment({
          postId: field('postId'),
          authorId: userId,
          body: field('body'),
          parentId: field('parentId') || null,
          isAnonymous: field('anonymous') === 'true',
        });
        return { ok: true };
      }
      case 'follow':
        return { ok: true, ...(await feedback.toggleFollow(field('postId'), userId)) };
      case 'set-status': {
        if (!isAdmin) return new Response('Forbidden', { status: 403 });
        const status = field('status');
        if (status && !isFeedbackStatus(status)) {
          return Response.json({ error: 'Unknown status.' }, { status: 400 });
        }
        // Followers get the note with the update, so an admin always writes one.
        await feedback.setStatus({
          postId: field('postId'),
          status: status && isFeedbackStatus(status) ? status : null,
          actorId: userId,
          note: field('note'),
          requireNote: true,
        });
        return { ok: true };
      }
      case 'mark-answered': {
        // The service checks the caller asked the question.
        return {
          ok: true,
          ...(await feedback.markQuestionAnswered({
            postId: field('postId'),
            userId,
            answered: field('answered') !== 'false',
          })),
        };
      }
      case 'mark-duplicate': {
        if (!isAdmin) return new Response('Forbidden', { status: 403 });
        // The original as its link (…/feedback/p/<id>) or its bare id.
        const original = field('originalId').trim();
        const { originalId } = await feedback.markDuplicate({
          postId: field('postId'),
          originalId: original.match(/\/feedback\/p\/([^/?#\s]+)/)?.[1] ?? original,
          actorId: userId,
        });
        return redirect(`/feedback/p/${originalId}`);
      }
      case 'delete-post': {
        const postId = field('postId');
        if (!isAdmin && (await feedback.getPostAuthorId(postId)) !== userId) {
          return new Response('Forbidden', { status: 403 });
        }
        await feedback.deletePost(postId);
        // Back to the board: staying would reload a post that no longer exists.
        return redirect('/feedback');
      }
      case 'delete-comment': {
        const commentId = field('commentId');
        if (!isAdmin && (await feedback.getCommentAuthorId(commentId)) !== userId) {
          return new Response('Forbidden', { status: 403 });
        }
        await feedback.deleteComment(commentId);
        return { ok: true };
      }
      default:
        return Response.json({ error: 'Unknown action.' }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof FeedbackValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof FeedbackNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
};
