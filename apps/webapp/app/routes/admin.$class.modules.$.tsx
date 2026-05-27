import type { LoaderFunctionArgs } from 'react-router';
import { redirectModulesToRepos } from '~/utils/redirects.server';

export async function loader({ params, request }: LoaderFunctionArgs) {
  return redirectModulesToRepos('admin', params.class, params['*'], request);
}
