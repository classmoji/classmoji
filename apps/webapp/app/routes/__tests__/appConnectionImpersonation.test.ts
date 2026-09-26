/**
 * Connecting an app (MCP OAuth) while a platform admin is viewing as another
 * user. The session then belongs to the viewed user, so an authorization code
 * issued now would give the app a token acting as them. Pins:
 *   - GET /api/auth/mcp/authorize and an approving POST /api/auth/oauth2/consent
 *     are refused server-side before better-auth runs;
 *   - denying consent, other auth endpoints, and ordinary sessions are
 *     unaffected;
 *   - the consent screen shows a note and turns Approve off.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  handler: vi.fn(),
  findApplication: vi.fn(),
  loaderData: {} as Record<string, unknown>,
}));

vi.mock('@classmoji/auth/server', () => ({
  auth: {
    api: { getSession: (...a: unknown[]) => mocks.getSession(...a) },
    handler: (...a: unknown[]) => mocks.handler(...a),
  },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    oauthApplication: { findUnique: (...a: unknown[]) => mocks.findApplication(...a) },
  }),
}));

vi.mock('react-router', () => ({
  redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
  useLoaderData: () => mocks.loaderData,
}));

const authRoute = await import('../api.auth.$.ts');
const consentRoute = await import('../oauth.consent/route.tsx');

const MESSAGE = "Connecting apps isn't available while viewing as another user.";
const VIEWING_AS = {
  user: { id: 'owner-1', name: 'owner' },
  session: { id: 's-1', impersonatedBy: 'platform-admin-1' },
};
const OWN_SESSION = { user: { id: 'owner-1', name: 'owner' }, session: { id: 's-1' } };

const authorize = () =>
  authRoute.loader({
    request: new Request(
      'http://localhost/api/auth/mcp/authorize?client_id=c1&response_type=code&redirect_uri=http://localhost:9/cb'
    ),
  } as unknown as Parameters<typeof authRoute.loader>[0]) as Promise<Response>;

const consent = (accept: boolean) =>
  authRoute.action({
    request: new Request('http://localhost/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept, consent_code: 'code-1' }),
    }),
  } as unknown as Parameters<typeof authRoute.action>[0]) as Promise<Response>;

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.handler.mockReset();
  mocks.findApplication.mockReset();
  mocks.handler.mockResolvedValue(new Response('from better-auth', { status: 200 }));
  mocks.findApplication.mockResolvedValue({ name: 'Claude', icon: null });
});

describe('auth handler while viewing as another user', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue(VIEWING_AS);
  });

  it('refuses the authorization endpoint', async () => {
    const response = await authorize();

    expect(response.status).toBe(403);
    expect(await response.text()).toBe(MESSAGE);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('refuses approving consent, with a message the consent screen shows', async () => {
    const response = await consent(true);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'access_denied',
      error_description: MESSAGE,
    });
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('lets a consent denial through, since it issues nothing', async () => {
    await consent(false);
    expect(mocks.handler).toHaveBeenCalledOnce();
  });

  it('leaves other auth endpoints alone, without looking up the session', async () => {
    await authRoute.loader({
      request: new Request('http://localhost/api/auth/get-session'),
    } as unknown as Parameters<typeof authRoute.loader>[0]);

    expect(mocks.handler).toHaveBeenCalledOnce();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});

describe('auth handler for an ordinary session', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue(OWN_SESSION);
  });

  it('passes authorization through to better-auth', async () => {
    const response = await authorize();
    expect(response.status).toBe(200);
    expect(mocks.handler).toHaveBeenCalledOnce();
  });

  it('passes an approving consent through to better-auth', async () => {
    await consent(true);
    expect(mocks.handler).toHaveBeenCalledOnce();
  });

  it('passes authorization through when nobody is signed in (better-auth sends them to sign in)', async () => {
    mocks.getSession.mockResolvedValue(null);
    await authorize();
    expect(mocks.handler).toHaveBeenCalledOnce();
  });
});

describe('consent screen', () => {
  const loadConsent = () =>
    consentRoute.loader({
      request: new Request(
        'http://localhost/oauth/consent?consent_code=code-1&client_id=c1&scope=read%20write'
      ),
    } as unknown as Parameters<typeof consentRoute.loader>[0]) as Promise<Record<string, unknown>>;

  it('reports viewing as another user', async () => {
    mocks.getSession.mockResolvedValue(VIEWING_AS);
    expect(await loadConsent()).toMatchObject({ viewingAsAnotherUser: true });
  });

  it('reports an ordinary session', async () => {
    mocks.getSession.mockResolvedValue(OWN_SESSION);
    expect(await loadConsent()).toMatchObject({ viewingAsAnotherUser: false });
  });

  const render = (viewingAsAnotherUser: boolean) => {
    mocks.loaderData = {
      consentCode: 'code-1',
      clientName: 'Claude',
      clientIcon: null,
      scopes: ['read'],
      userLogin: 'owner',
      viewingAsAnotherUser,
    };
    return renderToStaticMarkup(createElement(consentRoute.default));
  };

  const approveButton = (html: string) => html.match(/<button[^>]*>Approve<\/button>/)?.[0] ?? '';

  it('shows the note and turns Approve off while viewing as another user', () => {
    const html = render(true);
    expect(html).toContain('Connecting apps isn&#x27;t available while viewing as another user.');
    expect(approveButton(html)).toContain('disabled=""');
  });

  it('keeps Approve on for an ordinary session', () => {
    const html = render(false);
    expect(html).not.toContain('connect-app-notice');
    expect(approveButton(html)).not.toContain('disabled=""');
  });
});
