/**
 * The first-run setup wizard (`/setup` and `/setup/callback`) runs only while
 * `SETUP_GITHUB_APP` is set and the server is not a production build. While it
 * is off, every request to either route is answered with a redirect to `/`,
 * with no call to Github, no change to `process.env` and no file written.
 *
 * Driven through React Router's own request handler over the app's real route
 * tree. The two setup routes are the real modules; every other route, the root
 * included, is a stub that lets every request through, so only the setup
 * routes' own checks decide.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestHandler,
  UNSAFE_decodeViaTurboStream as decodeViaTurboStream,
  UNSAFE_SingleFetchRedirectSymbol as SingleFetchRedirectSymbol,
  type ServerBuild,
} from 'react-router';

// The setup page's component imports; no component renders in these tests.
vi.mock('antd', () => ({ Button: () => null }));
vi.mock('@classmoji/ui-components', () => ({ Logo: () => null }));

const SETUP = 'routes/setup';
const CALLBACK = 'routes/setup.callback';

(globalThis as { __reactRouterAppDirectory?: string }).__reactRouterAppDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
);
const routeConfig = await (await import('../../../routes')).default;
const setupRoute = await import('../../setup/route');
const callbackRoute = await import('../route');
const { routerArgs } = await import('~/__tests__/support/routerUrl');

type Entry = {
  id?: string;
  file: string;
  path?: string;
  index?: boolean;
  caseSensitive?: boolean;
  children?: Entry[];
};

const stub = { default: () => null, loader: () => ({ user: null }) };
const realModules: Record<string, unknown> = { [SETUP]: setupRoute, [CALLBACK]: callbackRoute };

const routes: Record<string, unknown> = { root: { id: 'root', path: '', module: stub } };
const addRoutes = (entries: Entry[], parentId: string) => {
  for (const entry of entries) {
    const id = entry.id ?? entry.file.replace(/^\.\//, '').replace(/\.[jt]sx?$/, '');
    routes[id] = {
      id,
      parentId,
      path: entry.path,
      index: entry.index,
      caseSensitive: entry.caseSensitive,
      module: realModules[id] ?? stub,
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

const send = (pathname: string, init?: RequestInit) =>
  handle(new Request(`http://localhost${pathname}`, init));

/** Where a response sends the browser: a document redirect, or a single-fetch one. */
const redirectTarget = async (response: Response): Promise<string | null> => {
  if (response.status >= 300 && response.status < 400) return response.headers.get('Location');
  if (response.status !== 202) return null;
  const { value } = await decodeViaTurboStream(response.body as ReadableStream, globalThis);
  return (
    ((value as Record<symbol, { redirect?: string }>)[SingleFetchRedirectSymbol]?.redirect as
      | string
      | undefined) ?? null
  );
};

const GITHUB_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_PRIVATE_KEY_BASE64',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_NAME',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
] as const;

const APP = {
  id: 42,
  pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
  webhook_secret: 'whsec',
  name: 'classmoji-abc123',
  client_id: 'Iv1.client',
  client_secret: 'client-secret',
};

let savedEnv: NodeJS.ProcessEnv;
const fetchMock = vi.fn();
let writeSpy: ReturnType<typeof vi.spyOn>;
let renameSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of GITHUB_KEYS) process.env[key] = `existing-${key}`;
  delete process.env.SETUP_GITHUB_APP;
  process.env.NODE_ENV = 'development';

  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);

  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((
    file: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) =>
    String(file).endsWith(`${path.sep}.env`)
      ? 'SETUP_GITHUB_APP="true"\nGITHUB_APP_ID=""\n'
      : (readFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof fs.readFileSync);
  writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

const githubValues = () => Object.fromEntries(GITHUB_KEYS.map(key => [key, process.env[key]]));
const untouchedValues = Object.fromEntries(GITHUB_KEYS.map(key => [key, `existing-${key}`]));

const CALLBACK_REQUESTS = {
  document: '/setup/callback?code=abc',
  data: '/setup/callback.data?code=abc',
  'data naming only the callback': `/setup/callback.data?_routes=${CALLBACK}&code=abc`,
};
const SETUP_REQUESTS = {
  document: '/setup',
  data: '/setup.data',
  'data naming only the setup page': `/setup.data?_routes=${SETUP}`,
};

const OFF = {
  'the switch is unset': () => {},
  'the server is a production build': () => {
    process.env.SETUP_GITHUB_APP = 'true';
    process.env.NODE_ENV = 'production';
  },
};

describe('setup wizard while it is off', () => {
  for (const [why, arrange] of Object.entries(OFF)) {
    for (const [kind, url] of Object.entries(CALLBACK_REQUESTS)) {
      it(`the callback answers a redirect to / and does nothing else (${kind}, ${why})`, async () => {
        arrange();
        const setupBefore = process.env.SETUP_GITHUB_APP;

        const response = await send(url);

        expect(await redirectTarget(response)).toBe('/');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(writeSpy).not.toHaveBeenCalled();
        expect(renameSpy).not.toHaveBeenCalled();
        expect(githubValues()).toEqual(untouchedValues);
        expect(process.env.SETUP_GITHUB_APP).toBe(setupBefore);
      });
    }

    for (const [kind, url] of Object.entries(SETUP_REQUESTS)) {
      it(`the setup page answers a redirect to / (${kind}, ${why})`, async () => {
        arrange();
        const response = await send(url);
        expect(await redirectTarget(response)).toBe('/');
      });
    }

    it(`a POST to either route runs none of the wizard (${why})`, async () => {
      arrange();
      for (const url of [...Object.values(CALLBACK_REQUESTS), ...Object.values(SETUP_REQUESTS)]) {
        const response = await send(url, { method: 'POST', body: new URLSearchParams() });
        // Neither route has an action, so a POST is refused and nothing redirects.
        expect(await redirectTarget(response)).toBeNull();
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
      expect(githubValues()).toEqual(untouchedValues);
    });
  }
});

describe('setup wizard while it is on', () => {
  beforeEach(() => {
    process.env.SETUP_GITHUB_APP = 'true';
  });

  it('the setup page returns the manifest for Github', async () => {
    delete process.env.WEBAPP_URL;
    const data = (await setupRoute.loader(
      routerArgs('http://localhost/setup?error=no_code', {
        headers: { host: 'localhost' },
      }) as unknown as Parameters<typeof setupRoute.loader>[0]
    )) as { manifest: string; error: string | null };

    expect(data.error).toBe('no_code');
    expect(JSON.parse(data.manifest)).toMatchObject({
      redirect_url: 'http://localhost/setup/callback',
    });
    expect((await send(`/setup.data?_routes=${SETUP}`)).status).toBe(200);
  });

  it('the callback converts the code, stores the App values and finishes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(APP), { status: 201 }));

    const response = await send('/setup/callback?code=abc');

    expect(await redirectTarget(response)).toBe('/?setup=complete');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/app-manifests/abc/conversions');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });

    expect(process.env.SETUP_GITHUB_APP).toBeUndefined();
    expect(githubValues()).toEqual({
      GITHUB_APP_ID: '42',
      GITHUB_PRIVATE_KEY_BASE64: Buffer.from(APP.pem).toString('base64'),
      GITHUB_WEBHOOK_SECRET: 'whsec',
      GITHUB_APP_NAME: 'classmoji-abc123',
      GITHUB_CLIENT_ID: 'Iv1.client',
      GITHUB_CLIENT_SECRET: 'client-secret',
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [tmpPath, content] = writeSpy.mock.calls[0] as [string, string];
    expect(tmpPath.endsWith(`${path.sep}.env.tmp`)).toBe(true);
    expect(content).toContain('SETUP_GITHUB_APP=""');
    expect(content).toContain('GITHUB_APP_ID="42"');
    expect(renameSpy).toHaveBeenCalledWith(tmpPath, tmpPath.replace(/\.tmp$/, ''));
  });

  it('the callback reports a code Github does not accept', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }));

    const response = await send(`/setup/callback.data?_routes=${CALLBACK}&code=bad`);

    expect(await redirectTarget(response)).toBe('/setup?error=conversion_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(githubValues()).toEqual(untouchedValues);
  });
});
