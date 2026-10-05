import { useFetcher, useLocation, useNavigate } from 'react-router';
import { FEEDBACK_ACTION, signInHref } from './feedback';

/**
 * A fetcher for one board action (vote, follow, comment…). Signed-out people
 * are sent to sign in and brought back here instead of posting.
 */
export function useFeedbackAction(signedIn: boolean) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string; postId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const submit = (fields: Record<string, string>) => {
    if (!signedIn) {
      navigate(signInHref(`${location.pathname}${location.search}`));
      return;
    }
    fetcher.submit(fields, { method: 'post', action: FEEDBACK_ACTION });
  };

  return { fetcher, submit, pending: fetcher.state !== 'idle' };
}

/**
 * The vote as the person sees it: flipped the moment they click, settled by
 * the server's answer once the loaders revalidate.
 */
export function useOptimisticVote(
  intent: 'vote' | 'comment-vote',
  idField: 'postId' | 'commentId',
  id: string,
  count: number,
  voted: boolean,
  signedIn: boolean
) {
  const { fetcher, submit } = useFeedbackAction(signedIn);
  const inFlight = fetcher.formData?.get('intent') === intent;
  const shownVoted = inFlight ? !voted : voted;
  const shownCount = inFlight ? count + (voted ? -1 : 1) : count;
  return {
    voted: shownVoted,
    count: shownCount,
    toggle: () => submit({ intent, [idField]: id }),
  };
}
