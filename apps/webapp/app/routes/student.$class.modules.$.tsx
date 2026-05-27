import type { LoaderFunctionArgs } from 'react-router';
import { redirectModulesToRepos } from '~/utils/redirects.server';

export async function loader({ params, request }: LoaderFunctionArgs) {
  return redirectModulesToRepos('student', params.class, params['*'], request);
}
