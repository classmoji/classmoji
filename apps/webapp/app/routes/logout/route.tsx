import { redirect } from 'react-router';
import { userCookie } from '~/utils/cookies';

/**
 * Logout route - clears the auth cookie server-side
 * Required because the cookie is httpOnly and can't be cleared by JavaScript
 */
export const loader = async () => {
  return redirect('/', {
    headers: {
      'Set-Cookie': await userCookie.serialize('', { maxAge: 0 }),
    },
  });
};
