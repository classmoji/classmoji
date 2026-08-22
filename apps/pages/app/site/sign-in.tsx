import { data, redirect, useLoaderData } from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from 'react-router';

import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import { resolveSiteContext } from './tenant.server.ts';
import { sanitizeReturnTo } from './returnTo.ts';
import { signInHandoffUrl } from './signInToken.server.ts';
import { webappUrl } from './env.server.ts';

/**
 * `/sign-in` — the members-only interstitial.
 *
 * Deliberately a page and not an automatic bounce. A visitor who clicks a link
 * shared in a lecture and is silently thrown at a GitHub OAuth screen has no
 * idea what happened or why; a sentence naming the course turns that into an
 * obvious, expected step. It also keeps the site honest: nothing on a public
 * host should redirect an anonymous visitor to a third party without telling
 * them first.
 *
 * Never cacheable, never indexed.
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { request } = args;
  const { site, customDomain, memberLinkOrigin } = await resolveSiteContext(args);

  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));

  // A custom domain cannot hold a Classmoji session cookie, so signing in from
  // here would complete the OAuth round trip and land the visitor back on a
  // host that still sees them as anonymous. Every link in the site chrome
  // already points at the canonical subdomain's interstitial; this covers a
  // direct visit, a bookmark, or a link shared before the domain was connected.
  // The already-sanitized `returnTo` is carried across so the trip still ends
  // where it started.
  if (customDomain) {
    const target =
      returnTo === '/' ? '/sign-in' : `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
    throw redirect(`${memberLinkOrigin}${target}`, {
      status: 302,
      headers: siteHeaders({ request, cacheable: false, noindex: true }),
    });
  }

  // Minted per request: the token has a 5-minute TTL, and this response is
  // `no-store` precisely so a cached copy can never hand out a dead one.
  const handoff = signInHandoffUrl(webappUrl(), {
    classroomId: site.classroom_id,
    path: returnTo,
  });

  return data(
    {
      courseName: site.classroom.name,
      // Only promise a return trip when the hand-off is actually signed.
      returnTo: handoff.signed ? returnTo : '/',
      signInUrl: handoff.url,
    },
    { headers: siteHeaders({ request, cacheable: false, noindex: true }) }
  );
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

export const meta: MetaFunction<typeof loader> = ({ data: loaderData }) => [
  { title: loaderData ? `Sign in — ${loaderData.courseName}` : 'Sign in' },
  { name: 'robots', content: 'noindex' },
];

const SiteSignIn = () => {
  const { courseName, returnTo, signInUrl } = useLoaderData<typeof loader>();

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-3 text-2xl font-semibold text-gray-900 dark:text-gray-100">
        This page is for members of {courseName}
      </h1>
      <p className="mb-8 text-gray-600 dark:text-gray-400">
        Sign in with your Classmoji account to continue. If you are enrolled, you will come straight
        back here.
      </p>

      <a
        href={signInUrl}
        className="rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white no-underline hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
      >
        Sign in with GitHub →
      </a>

      {returnTo !== '/' ? (
        <p className="mt-6 text-xs text-gray-500 dark:text-gray-500">
          You will return to <code className="font-mono">{returnTo}</code>
        </p>
      ) : null}
    </div>
  );
};

export default SiteSignIn;
