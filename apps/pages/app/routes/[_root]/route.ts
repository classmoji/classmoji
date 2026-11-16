import { redirectDocument, type MiddlewareFunction } from 'react-router';

/**
 * TEMPORARY: delete this route once the React Router 8 release has been out
 * for a while.
 *
 * A tab opened before that deploy keeps running the React Router 7 client,
 * which fetches the home page's data from `/_root.data` (React Router 8 uses
 * `/_.data`). The new server reads that as the page `/_root`, so without this
 * route the old tab gets an error page when it navigates home. Here every
 * request for `/_root` answers a document redirect to `/`, query kept (e.g.
 * `/?redirect=…` from a sign-in link): the tab does a full load of the home
 * page and picks up the new client.
 *
 * It has to be middleware, not only a loader. When the old client sends
 * `?_routes=` (a route on the way skipped revalidating), the ids name the home
 * page's routes, never this one, so this loader would not run. Without
 * `_routes`, the root loader and its gates would run alongside it and could
 * answer first. Middleware runs for every matched route and answers before any
 * loader runs. It returns no data. The loader covers a new client that somehow
 * navigates to `/_root`.
 */
const reloadHome = ({ url }: { url: URL }) => redirectDocument(`/${url.search}`);

export const middleware: MiddlewareFunction<Response>[] = [reloadHome];
export const loader = reloadHome;
