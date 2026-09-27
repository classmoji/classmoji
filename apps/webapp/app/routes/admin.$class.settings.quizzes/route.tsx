import { redirect } from 'react-router';
import type { Route } from './+types/route';

/**
 * The Quizzes settings tab became the AI tab (/settings/ai). This keeps old
 * links and bookmarks working. It reveals nothing on its own: the target
 * route runs its own OWNER gate, and the admin.$class layout gates browsing.
 */
export const loader = ({ params }: Route.LoaderArgs) =>
  redirect(`/admin/${params.class}/settings/ai`);

export default function SettingsQuizzesRedirect() {
  return null;
}
