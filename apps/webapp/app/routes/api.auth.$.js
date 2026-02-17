import { auth } from '@classmoji/auth/server';

export async function loader({ request }) {
  return auth.handler(request);
}

export async function action({ request }) {
  return auth.handler(request);
}
