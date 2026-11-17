import { registerHooks } from 'node:module';

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

/** Loader args for a raw request URL: `request` as sent, `url` as React Router 8 builds it. */
export const routerArgs = (raw: string, init?: RequestInit) => ({
  request: new Request(raw, init),
  url: routerUrl(raw),
});

/** An ES module from source, for `importWithStubs`. */
export const stubModule = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

/**
 * Import a FRESH instance of an app module (`?stubbed` keeps it apart from a
 * copy another spec in this worker already loaded) whose own imports are
 * swapped for stubs: a key ending in `.css` stands for every stylesheet, any
 * other key is a resolved-path suffix (`/app/utils/db.server.ts`) or a bare
 * specifier (`@classmoji/auth/server`). Only that module's direct imports are
 * swapped, and only during the import; everything else loads as it is.
 */
export async function importWithStubs<T>(
  moduleUrl: URL,
  stubs: Record<string, string>
): Promise<T> {
  const marked = `${moduleUrl.href}?stubbed`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL !== marked) return next(specifier, context);
      if (specifier.endsWith('.css') && stubs['.css'])
        return { url: stubs['.css'], shortCircuit: true };
      if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true };
      const resolved = next(specifier, context);
      const suffix = Object.keys(stubs).find(key => resolved.url.endsWith(key));
      return suffix ? { url: stubs[suffix], shortCircuit: true } : resolved;
    },
  });
  try {
    return (await import(marked)) as T;
  } finally {
    hooks.deregister();
  }
}
