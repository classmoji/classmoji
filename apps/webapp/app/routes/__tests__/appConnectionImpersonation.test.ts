/**
 * The consent page while a platform admin is viewing as another user. The
 * refusal itself is server-side, in the shared better-auth hook, and is tested
 * in packages/auth (appConnectionGuard.test.ts, appConnection.integration.test.ts).
 * Here: the page reports the state, shows the note, and turns Approve off; and
 * both the webapp's and the admin app's auth routes hand the authorization
 * requests to the one shared handler unchanged.
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
const adminAuthRoute = await import('../../../../admin/app/routes/api.auth.$.ts');
const consentRoute = await import('../oauth.consent/route.tsx');

const VIEWING_AS = {
  user: { id: 'owner-1', name: 'owner' },
  session: { id: 's-1', impersonatedBy: 'platform-admin-1' },
};
const OWN_SESSION = { user: { id: 'owner-1', name: 'owner' }, session: { id: 's-1' } };

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.handler.mockReset();
  mocks.findApplication.mockReset();
  mocks.handler.mockResolvedValue(new Response('from better-auth', { status: 200 }));
  mocks.findApplication.mockResolvedValue({ name: 'Claude', icon: null });
});

describe('both apps hand /api/auth/* to the shared auth handler', () => {
  // The app-connection rules live in the shared better-auth hook, so what
  // matters here is that each origin passes these requests through untouched.
  const routes = [
    ['apps/webapp', authRoute],
    ['apps/admin', adminAuthRoute],
  ] as const;

  it.each(routes)('%s passes /mcp/authorize through unchanged', async (_app, route) => {
    const upstream = new Response(null, { status: 302 });
    mocks.handler.mockResolvedValue(upstream);
    const request = new Request(
      'http://localhost/api/auth/mcp/authorize?client_id=c1&response_type=code&prompt=none'
    );

    const response = await route.loader({ request } as unknown as Parameters<
      typeof route.loader
    >[0]);

    expect(mocks.handler).toHaveBeenCalledOnce();
    expect(mocks.handler.mock.calls[0]![0]).toBe(request);
    expect(response).toBe(upstream);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it.each(routes)(
    '%s passes an approving /oauth2/consent through unchanged',
    async (_app, route) => {
      const upstream = new Response('{}', { status: 200 });
      mocks.handler.mockResolvedValue(upstream);
      const request = new Request('http://localhost/api/auth/oauth2/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true, consent_code: 'x' }),
      });

      const response = await route.action({ request } as unknown as Parameters<
        typeof route.action
      >[0]);

      expect(mocks.handler).toHaveBeenCalledOnce();
      expect(mocks.handler.mock.calls[0]![0]).toBe(request);
      expect(response).toBe(upstream);
    }
  );
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
