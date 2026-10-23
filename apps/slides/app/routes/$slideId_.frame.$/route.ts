/**
 * `/{slideId}/frame/*` — the editor's frame source: a 302 to a freshly signed
 * files URL for a file in the deck's own content repo, behind the deck's view
 * gate. A RESOURCE route (no default export), like `$slideId_.download`, so a
 * 404 is a 404 rather than route data. See `~/utils/frameRoute.server`.
 */

import { frameRedirect } from '~/utils/frameRoute.server';

export const loader = ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => frameRedirect({ params, request });
