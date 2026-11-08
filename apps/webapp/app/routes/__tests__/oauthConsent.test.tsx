// @vitest-environment jsdom
/**
 * The consent page (routes/oauth.consent) on better-auth 1.7's oauth-provider.
 *
 * Loader:
 *   - the signed query is checked on the server first; an unsigned, changed or
 *     expired one shows "can't connect", before any session or client read;
 *   - a missing or turned-off client shows the same;
 *   - a signed-out visitor goes to sign in with the same signed query;
 *   - a client known by its metadata document shows its host; others don't;
 *   - whether the session is viewing as another user comes from both session
 *     reads (isViewingAsAnotherUser), for the request's own headers.
 * Page:
 *   - Approve and Deny post the signed query and follow the answer's `url`,
 *     only to an allowed target (never javascript: and the like);
 *   - a request that expired while the page was open says so;
 *   - while viewing as another user: the note, and Approve off;
 *   - the frame headers.
 * And the webapp hands /oauth2/authorize and /oauth2/consent to the shared
 * auth handler unchanged; the refusal while viewing as someone is
 * server-side, tested in packages/auth (appConnectionGuard.test.ts,
 * appConnection.integration.test.ts). The real signature check is tested
 * there too (verifiedAuthorizationQuery).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verified: vi.fn<(search: string) => Promise<URLSearchParams | null>>(),
  getSession: vi.fn(),
  viewingAs: vi.fn<(headers: Headers) => Promise<boolean>>(),
  findClient: vi.fn(),
  handler: vi.fn<(request: Request) => Promise<Response>>(),
  loaderData: {} as Record<string, unknown>,
}));

vi.mock('@classmoji/auth/server', () => ({
  auth: {
    api: { getSession: (...a: unknown[]) => mocks.getSession(...a) },
    handler: (r: Request) => mocks.handler(r),
  },
  verifiedAuthorizationQuery: (search: string) => mocks.verified(search),
  isViewingAsAnotherUser: (headers: Headers) => mocks.viewingAs(headers),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ oauthClient: { findUnique: (...a: unknown[]) => mocks.findClient(...a) } }),
}));

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useLoaderData: () => mocks.loaderData,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const consentRoute = await import('../oauth.consent/route.tsx');
const authRoute = await import('../api.auth.$.ts');
const { CONNECT_APP_VIEWING_AS_MESSAGE } = await import('@classmoji/auth/app-connection');

const SIGNED = new URLSearchParams([
  ['client_id', 'https://claude.ai/oauth/claude-code-client-metadata'],
  ['scope', 'read write offline_access'],
  ['state', 'client-state'],
  ['ba_param', 'ba_param'],
  ['ba_param', 'client_id'],
  ['ba_param', 'scope'],
  ['ba_param', 'state'],
  ['sig', 'signature'],
]);

const CIMD_CLIENT = {
  name: 'Claude Code',
  icon: null,
  disabled: false,
  clientDiscoveryId: 'cimd',
};
const SESSION = { user: { id: 'owner-1', name: 'Owner', email: 'o@example.edu' }, session: {} };

const load = (search = `?${SIGNED}&utm=page`) =>
  consentRoute.loader({
    request: new Request(`http://localhost:3000/oauth/consent${search}`, {
      headers: { cookie: 'classmoji.session_token=t' },
    }),
  } as never) as Promise<Record<string, unknown> | Response>;

beforeEach(() => {
  for (const fn of [
    mocks.verified,
    mocks.getSession,
    mocks.viewingAs,
    mocks.findClient,
    mocks.handler,
  ]) {
    fn.mockReset();
  }
  mocks.verified.mockResolvedValue(new URLSearchParams(SIGNED));
  mocks.getSession.mockResolvedValue(SESSION);
  mocks.viewingAs.mockResolvedValue(false);
  mocks.findClient.mockResolvedValue(CIMD_CLIENT);
});

describe('consent loader', () => {
  it('checks the signed query from the address, and refuses one that does not check out', async () => {
    mocks.verified.mockResolvedValue(null);

    expect(await load()).toEqual({ state: 'invalid' });
    expect(mocks.verified).toHaveBeenCalledWith(`?${SIGNED}&utm=page`);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.findClient).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['turned off', { ...CIMD_CLIENT, disabled: true }],
  ])('shows "can\'t connect" for a client that is %s', async (_label, client) => {
    mocks.findClient.mockResolvedValue(client);
    expect(await load()).toEqual({ state: 'invalid' });
    expect(mocks.findClient).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: SIGNED.get('client_id') } })
    );
  });

  it('sends a signed-out visitor to sign in with the signed query only', async () => {
    mocks.getSession.mockResolvedValue(null);

    const res = (await load()) as Response;

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/?${SIGNED}`);
  });

  it('shows the request: the signed query to post, the scopes, the client and its host', async () => {
    expect(await load()).toEqual({
      state: 'ready',
      oauthQuery: SIGNED.toString(),
      clientName: 'Claude Code',
      clientHost: 'claude.ai',
      clientIcon: null,
      scopes: ['read', 'write', 'offline_access'],
      userLogin: 'Owner',
      viewingAsAnotherUser: false,
    });
  });

  it('shows no host for a client that registered itself', async () => {
    mocks.findClient.mockResolvedValue({
      ...CIMD_CLIENT,
      name: 'Inspector',
      clientDiscoveryId: null,
    });
    expect(await load()).toMatchObject({ clientName: 'Inspector', clientHost: null });
  });

  it('reports viewing as another user, read from the request', async () => {
    mocks.viewingAs.mockResolvedValue(true);

    expect(await load()).toMatchObject({ viewingAsAnotherUser: true });
    const headers = mocks.viewingAs.mock.calls[0]![0];
    expect(headers.get('cookie')).toBe('classmoji.session_token=t');
  });

  it('keeps the frame headers', () => {
    expect(consentRoute.headers()).toEqual({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
  });
});

describe('consent page', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  const location = { href: 'http://localhost:3000/oauth/consent' };

  const READY = {
    state: 'ready',
    oauthQuery: SIGNED.toString(),
    clientName: 'Claude Code',
    clientHost: 'claude.ai',
    clientIcon: null,
    scopes: ['read', 'write'],
    userLogin: 'Owner',
    viewingAsAnotherUser: false,
  };

  const render = async (data: Record<string, unknown>) => {
    mocks.loaderData = data;
    await act(async () => root.render(<consentRoute.default />));
  };

  const button = (label: string) =>
    [...container.querySelectorAll('button')].find(b => b.textContent === label)!;

  const press = async (label: string) => {
    await act(async () => button(label).click());
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  };

  const answer = (body: unknown, status = 200) =>
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    location.href = 'http://localhost:3000/oauth/consent';
    vi.stubGlobal('location', location);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each([
    ['Approve', true, 'https://claude.ai/api/mcp/auth_callback?code=c1&state=client-state'],
    ['Deny', false, 'http://127.0.0.1:33418/callback?error=access_denied&state=client-state'],
    ['Approve', true, 'cursor://anysphere.cursor-retrieval/oauth/callback?code=c1'],
  ])('%s posts the signed query and goes to the answer (%s, %s)', async (label, accept, url) => {
    await render(READY);
    answer({ redirect: true, url });

    await press(label);

    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toBe('/api/auth/oauth2/consent');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ accept, oauth_query: SIGNED.toString() });
    expect(location.href).toBe(url);
  });

  it.each([
    ['javascript:alert(document.cookie)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['blob:http://localhost:3000/x'],
    ['/relative/page'],
  ])('never goes to %s', async url => {
    await render(READY);
    answer({ redirect: true, url });

    await press('Approve');

    expect(location.href).toBe('http://localhost:3000/oauth/consent');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      consentRoute.INVALID_REDIRECT_MESSAGE
    );
  });

  it('says to start again when the request expired while the page was open', async () => {
    await render(READY);
    answer({ error: 'invalid_signature' }, 400);

    await press('Approve');

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      consentRoute.CONNECTION_EXPIRED_MESSAGE
    );
    expect(location.href).toBe('http://localhost:3000/oauth/consent');
  });

  it("shows the server's refusal", async () => {
    await render(READY);
    answer({ error: 'access_denied', error_description: CONNECT_APP_VIEWING_AS_MESSAGE }, 403);

    await press('Approve');

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      CONNECT_APP_VIEWING_AS_MESSAGE
    );
  });

  it('shows the note and turns Approve off while viewing as another user', async () => {
    await render({ ...READY, viewingAsAnotherUser: true });

    expect(container.querySelector('[data-testid="connect-app-notice"]')?.textContent).toBe(
      CONNECT_APP_VIEWING_AS_MESSAGE
    );
    expect(button('Approve').disabled).toBe(true);
    expect(button('Deny').disabled).toBe(false);
  });

  it('keeps Approve on for an ordinary session, and names the client and its host', async () => {
    await render(READY);

    expect(container.querySelector('[data-testid="connect-app-notice"]')).toBeNull();
    expect(button('Approve').disabled).toBe(false);
    expect(container.querySelector('h1')?.textContent).toBe('Authorize Claude Code');
    expect(container.querySelector('[data-testid="client-host"]')?.textContent).toBe(
      'From claude.ai'
    );
  });

  it('wraps a long client name with no spaces in the heading and the request line', async () => {
    const name = 'N'.repeat(200);
    await render({ ...READY, clientName: name });

    const heading = container.querySelector('h1')!;
    expect(heading.textContent).toBe(`Authorize ${name}`);
    expect(heading.classList).toContain('break-words');
    const line = [...container.querySelectorAll('p')].find(p =>
      p.textContent?.includes('wants to access your Classmoji account')
    )!;
    expect(line.textContent).toContain(name);
    expect(line.classList).toContain('break-words');
  });

  it('shows "can\'t connect" with what to do, and no buttons, for a request that does not check out', async () => {
    await render({ state: 'invalid' });

    expect(container.querySelector('h1')?.textContent).toBe("Can't connect this app");
    expect(container.querySelector('[data-testid="connect-app-expired"]')?.textContent).toBe(
      consentRoute.CONNECTION_EXPIRED_MESSAGE
    );
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('the webapp hands the authorization requests to the shared auth handler', () => {
  it('passes /oauth2/authorize through unchanged', async () => {
    const upstream = new Response(null, { status: 302 });
    mocks.handler.mockResolvedValue(upstream);
    const request = new Request(
      'http://localhost/api/auth/oauth2/authorize?client_id=c1&response_type=code&prompt=none'
    );

    const response = await authRoute.loader({ request } as never);

    expect(mocks.handler).toHaveBeenCalledOnce();
    expect(mocks.handler.mock.calls[0]![0]).toBe(request);
    expect(response).toBe(upstream);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('passes an approving /oauth2/consent through unchanged', async () => {
    const upstream = new Response('{}', { status: 200 });
    mocks.handler.mockResolvedValue(upstream);
    const request = new Request('http://localhost/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: 'x' }),
    });

    const response = await authRoute.action({ request } as never);

    expect(mocks.handler.mock.calls[0]![0]).toBe(request);
    expect(response).toBe(upstream);
  });
});
