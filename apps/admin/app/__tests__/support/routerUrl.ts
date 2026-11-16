/**
 * The `url` React Router 8 hands a loader or action for a raw request URL.
 *
 * A client navigation fetches `/x.data?_routes=…` (the root is `/_.data`, a
 * trailing slash `/x/_.data`); the loader still gets that raw `request`, and a
 * `url` with the `.data` suffix and `_routes` gone, empty `index` values
 * dropped, the query re-serialized and no hash. Mirrors `getNormalizedPath`
 * (react-router `lib/server-runtime/urls`) and `createDataFunctionUrl`
 * (`lib/router/utils`).
 */
export const routerUrl = (raw: string): URL => {
  const url = new URL(raw);
  url.pathname = url.pathname.endsWith('/_.data')
    ? url.pathname.replace(/_\.data$/, '')
    : url.pathname.replace(/\.data$/, '');
  const params = new URLSearchParams(url.search);
  params.delete('_routes');
  const index = params.getAll('index');
  params.delete('index');
  for (const value of index.filter(Boolean)) params.append('index', value);
  const search = params.toString();
  url.search = search ? `?${search}` : '';
  url.hash = '';
  return url;
};

/** Loader/action args for a raw request URL: `request` as sent, `url` as React Router 8 builds it. */
export const routerArgs = (raw: string, init?: RequestInit) => ({
  request: new Request(raw, init),
  url: routerUrl(raw),
});
