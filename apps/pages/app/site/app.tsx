import { redirect } from 'react-router';
import type { HeadersFunction, LoaderFunctionArgs } from 'react-router';

import { SiteNotice } from './chrome.tsx';
import { routeSiteHeaders, siteHeaders } from './headers.server.ts';
import { resolveSiteContext, rolePrefix } from './tenant.server.ts';
import { webappUrl } from './env.server.ts';

/**
 * `/app` — the one-domain bridge.
 *
 * A course site is a reading surface; the moment a visitor wants to *do*
 * something (submit, grade, take a quiz) they belong in the app. Rather than
 * printing four different dashboard URLs across the site chrome, every such
 * link points here and this route resolves the right one from the viewer's
 * role. That keeps the site's HTML free of role-specific URLs, which matters
 * because that HTML is shared-cacheable for anonymous visitors.
 *
 * Never cacheable: the destination depends entirely on who is asking.
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { request } = args;
  const { site, viewer, customDomain, memberLinkOrigin } = await resolveSiteContext(args);
  const headers = siteHeaders({ request, cacheable: false, noindex: true });

  // On a custom domain there is no session to resolve a role from, so this
  // bridge cannot do its job here — hand the request to the canonical
  // subdomain's copy, which can. Bouncing everyone to the app's front door
  // instead would drop a signed-in member back at a generic landing page.
  if (customDomain) {
    throw redirect(`${memberLinkOrigin}/app`, { headers });
  }

  const prefix = rolePrefix(viewer.role);
  if (!prefix) {
    // Anonymous, or signed in without membership — the app's front door is the
    // only thing we can honestly send them to.
    throw redirect(`${webappUrl()}/`, { headers });
  }

  throw redirect(`${webappUrl()}/${prefix}/${site.classroom.slug}/dashboard`, { headers });
};

export const headers: HeadersFunction = args => routeSiteHeaders(args);

/**
 * Only reachable if the redirect above did not happen, which it always does.
 * Present so the route is a document route (and therefore gets the layout's
 * branded error boundary) rather than a resource route.
 */
const SiteAppBridge = () => (
  <SiteNotice title="Opening Classmoji" message="Redirecting you to the Classmoji app." />
);

export default SiteAppBridge;
