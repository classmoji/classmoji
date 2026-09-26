import useStore from '~/store';
import { gitContextFor, gitWeb, type ClassroomLike } from '~/utils/gitWeb';

/**
 * Repo links for the classroom being viewed (Github or GitLab). Reads the
 * classroom root.tsx puts in the store for every /:role/:class page.
 */
/** The current classroom's git context, for helpers that take one. */
export const useGitContext = () =>
  gitContextFor(useStore(state => state.classroom) as ClassroomLike | null);

export const useGitWeb = () => {
  const classroom = useStore(state => state.classroom) as ClassroomLike | null;
  return gitWeb(gitContextFor(classroom));
};
