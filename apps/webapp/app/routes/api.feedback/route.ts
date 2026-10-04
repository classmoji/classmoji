/**
 * Every write on the feedback board.
 *
 * POST /api/feedback   form fields: intent + the ids/fields that intent needs
 *
 * Auth: a session for everything. Platform admins (PLATFORM_ADMIN_USER_IDS)
 * may also set a post's status and delete anyone's post or comment; everyone
 * else may delete only their own.
 */

import { redirect } from 'react-router';
import { PLATFORM_ADMIN_USER_IDS, requireAuth } from '@classmoji/auth/server';
import {
  ClassmojiService,
  FeedbackNotFoundError,
  FeedbackValidationError,
  isFeedbackStatus,
} from '@classmoji/services';
import { allowFeedbackAction } from '~/utils/feedbackRate.server';
import type { Route } from './+types/route';

const feedback = ClassmojiService.feedback;

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
        // Every post is a feature request for now; the board has no other kind.
        const { id } = await feedback.createPost({
          authorId: userId,
          title: field('title'),
          body: field('body'),
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
        await feedback.setStatus({
          postId: field('postId'),
          status: status && isFeedbackStatus(status) ? status : null,
          actorId: userId,
        });
        return { ok: true };
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
