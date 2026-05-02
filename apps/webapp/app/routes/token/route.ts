import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { proxyToBetterAuthOAuth } from '~/utils/oauthProxy.server';

export const loader = ({ request }: LoaderFunctionArgs) =>
  proxyToBetterAuthOAuth(request, 'token');
export const action = ({ request }: ActionFunctionArgs) =>
  proxyToBetterAuthOAuth(request, 'token');
