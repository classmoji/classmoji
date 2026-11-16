/**
 * TEMPORARY, deleted with `routes/[_root]`: a tab still running the React
 * Router 7 client asks for the home page's data at `/_root.data`, with or
 * without `?_routes=` naming the home page's routes. Every such request must answer a
 * document reload to `/` and run no other loader, signed in or out.
 *
 * Driven through React Router's own request handler over the app's real route
 * tree (every other module stubbed), so the test fails if the route, or only
 * its middleware, goes away.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createRequestHandler,
  redirect,
  UNSAFE_decodeViaTurboStream as decodeViaTurboStream,
  UNSAFE_SingleFetchRedirectSymbol as SingleFetchRedirectSymbol,
  type ServerBuild,
} from 'react-router';

const HOME = 'routes/_shell._index';
const BRIDGE = 'routes/[_root]';

(globalThis as { __reactRouterAppDirectory?: string }).__reactRouterAppDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
);
// `flatRoutes()` alone hands back a promise (admin, slides); await covers both.
const routeConfig = await (await import('../../../routes')).default;
const bridge = await import('../route');

type Entry = {
  id?: string;
  file: string;
  path?: string;
  index?: boolean;
  caseSensitive?: boolean;
  children?: Entry[];
};

// Every stub loader records that it ran and, like the real root gate, sends a
// signed-out request to `/`.
const calls: string[] = [];
const stub = (id: string) => ({
  default: () => null,
  loader: ({ request }: { request: Request }) => {
    calls.push(id);
    if (!request.headers.get('cookie')) throw redirect('/');
    return { id };
  },
});

const routes: Record<string, unknown> = { root: { id: 'root', path: '', module: stub('root') } };
const addRoutes = (entries: Entry[], parentId: string) => {
  for (const entry of entries) {
    const id = entry.id ?? entry.file.replace(/^\.\//, '').replace(/\.[jt]sx?$/, '');
    routes[id] = {
      id,
      parentId,
      path: entry.path,
      index: entry.index,
      caseSensitive: entry.caseSensitive,
      module: id === BRIDGE ? bridge : stub(id),
    };
    if (entry.children) addRoutes(entry.children, id);
  }
};
addRoutes(routeConfig as unknown as Entry[], 'root');

const handle = createRequestHandler(
  {
    entry: { module: { default: () => new Response('document') } },
    routes,
    assets: { entry: { module: '/entry.js', imports: [] }, routes: {}, url: '/m.js', version: 't' },
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'lazy', manifestPath: '/__manifest' },
  } as unknown as ServerBuild,
  'test'
);

const send = (pathname: string, cookie?: string) =>
  handle(new Request(`http://localhost${pathname}`, { headers: cookie ? { cookie } : {} }));

const SESSIONS = { 'signed out': undefined, 'signed in': 'session=abc' };

describe('/_root.data from a tab opened before React Router 8', () => {
  for (const [session, cookie] of Object.entries(SESSIONS)) {
    for (const query of ['', `?_routes=${HOME}`, `?_routes=root,${HOME}`]) {
      it(`answers a document reload to / (${session}, ${query || 'no _routes'})`, async () => {
        calls.length = 0;
        const response = await send(`/_root.data${query}`, cookie);

        expect(response.status).toBe(202);
        expect(response.headers.get('X-Remix-Response')).toBe('yes');
        const { value } = await decodeViaTurboStream(response.body as ReadableStream, globalThis);
        expect((value as Record<symbol, unknown>)[SingleFetchRedirectSymbol]).toEqual({
          redirect: '/',
          status: 302,
          reload: true,
          revalidate: false,
          replace: false,
        });
        expect(calls).toEqual([]);
      });
    }
  }

  it('sends a document request for /_root to /', async () => {
    calls.length = 0;
    const response = await send('/_root');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    expect(response.headers.get('X-Remix-Reload-Document')).toBe('true');
    expect(calls).toEqual([]);
  });

  it('keeps the query, so a sign-in link keeps its way back', async () => {
    const response = await send(`/_root.data?redirect=%2Ffeedback&_routes=${HOME}`);
    expect(response.status).toBe(202);
    const { value } = await decodeViaTurboStream(response.body as ReadableStream, globalThis);
    expect((value as Record<symbol, unknown>)[SingleFetchRedirectSymbol]).toMatchObject({
      redirect: '/?redirect=%2Ffeedback',
      reload: true,
    });
    expect((await send('/_root?redirect=%2Ffeedback')).headers.get('Location')).toBe(
      '/?redirect=%2Ffeedback'
    );
  });

  it('leaves the home data request of the new client alone', async () => {
    calls.length = 0;
    const response = await send(`/_.data?_routes=${HOME}`, SESSIONS['signed in']);
    expect(response.status).toBe(200);
    expect(calls).toEqual([HOME]);
  });
});
