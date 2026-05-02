import { auth } from '@classmoji/auth/server';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import type { LoaderFunctionArgs } from 'react-router';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler = oauthProviderAuthServerMetadata(auth as any);

export async function loader({ request }: LoaderFunctionArgs) {
  return handler(request);
}
