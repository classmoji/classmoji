import { data, redirect } from 'react-router';

import { getAuthSession } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';

import { planSiteReturn, resolveSiteDestination } from './siteReturn.ts';
import type { Route } from './+types/route';

/**
 * The webapp end of the course-site sign-in round trip.
 *
 * A visitor on {subdomain}.classmoji.io clicks "sign in"; the site sends them
 * here with a short-lived signed token naming the classroom and the page they
 * were on. We sign them in (via the normal landing page + OAuth) and hand them
 * back to the site.
 *
 * The token is not a credential — it is re-verified here and the site row is
 * re-read from the database before anyone is redirected anywhere, so revoking a
 * site takes effect immediately no matter how many links are in flight. See
 * packages/auth/src/siteReturnToken.ts for why the flow exists at all.
 *
 * All the branching lives in ./siteReturn.ts; this file is glue.
 */

/**
 * Nothing on this route may be cached or indexed: every response is specific to
 * one visitor and one token, and two of the three are redirects to a tenant
 * host. The `headers` export is what carries loader headers onto a document
 * response; redirects short-circuit it, so they set the same headers directly.
 */
const NO_STORE = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
} as const;

export const headers = () => NO_STORE;

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);

  // getAuthSession (not auth.api.getSession) so the dev test-login path counts
  // as signed in — it is the only way to exercise this route locally.
  const authData = await getAuthSession(request);
  const plan = planSiteReturn(url.searchParams.get('token'), Boolean(authData?.userId));

  if (plan.action === 'invalid-token') {
    return data({ reason: 'expired' as const }, { status: 400, headers: NO_STORE });
  }

  if (plan.action === 'sign-in') {
    return redirect(plan.redirectTo, { headers: NO_STORE });
  }

  // Fresh read, every time: the token says which classroom, the database says
  // whether that classroom still has a site and where it lives.
  const site = await ClassmojiService.site.getSiteForClassroom(plan.classroomId);
  const destination = resolveSiteDestination(site, plan.path, process.env);

  if (destination.action === 'site-unavailable') {
    return data({ reason: 'unavailable' as const }, { status: 404, headers: NO_STORE });
  }

  return redirect(destination.url, { headers: NO_STORE });
};

const MESSAGES = {
  expired: {
    title: 'This sign-in link expired',
    body: 'Go back to the course site and try signing in again.',
  },
  unavailable: {
    title: 'This course site is no longer available',
    body: 'The instructor may have turned it off. Check with them if you think this is a mistake.',
  },
} as const;

/**
 * Only ever rendered for the two failure branches — the success paths are
 * redirects. Intentionally has no link back: we know the site the visitor came
 * from, but linking to a site we just refused to send them to is the one thing
 * this page must not do.
 */
const SiteReturn = ({ loaderData }: Route.ComponentProps) => {
  const message = MESSAGES[loaderData?.reason ?? 'expired'];

  return (
    <div className="flex min-h-screen items-center justify-center bg-lightGray p-6 dark:bg-neutral-950">
      <div className="max-w-md rounded-2xl bg-white p-8 text-center ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <h1 className="text-base font-semibold text-gray-700 dark:text-gray-300">
          {message.title}
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{message.body}</p>
      </div>
    </div>
  );
};

export default SiteReturn;
