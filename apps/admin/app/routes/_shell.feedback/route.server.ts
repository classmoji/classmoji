import { ClassmojiService } from '@classmoji/services';
import type { LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';

/**
 * The feedback board's feature requests ranked for deciding what to build,
 * and who voted for one of them. Voter names and emails exist only here:
 * the board and the MCP show counts at most.
 */
export async function loadFeedbackRanking({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const postId = new URL(request.url).searchParams.get('post');
  const [ranking, voters] = await Promise.all([
    ClassmojiService.feedback.listFeatureRanking(),
    postId ? ClassmojiService.feedback.listFeatureVoters(postId) : Promise.resolve(null),
  ]);
  return {
    ranking: ranking.map(post => ({ ...post, created_at: post.created_at.toISOString() })),
    selectedId: postId,
    voters: voters?.map(v => ({ ...v, votedAt: v.votedAt.toISOString() })) ?? null,
    webappUrl: process.env.WEBAPP_URL ?? 'http://localhost:3000',
  };
}
