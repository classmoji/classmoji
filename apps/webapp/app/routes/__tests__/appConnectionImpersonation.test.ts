/**
 * The consent page while a platform admin is viewing as another user. The
 * refusal itself is server-side, in the shared better-auth hook, and is tested
 * in packages/auth (appConnectionGuard.test.ts, appConnection.integration.test.ts).
 * Here: the page reports the state, shows the note, and turns Approve off; and
 * the webapp's auth route hands every request to the shared handler.
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

describe('webapp auth route', () => {
  it('hands authorization to the shared auth handler, where the rules run', async () => {
    mocks.handler.mockResolvedValue(new Response(null, { status: 302 }));
    const response = (await authRoute.loader({
      request: new Request('http://localhost/api/auth/mcp/authorize?client_id=c1'),
    } as unknown as Parameters<typeof authRoute.loader>[0])) as Response;

    expect(mocks.handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(302);
    // No second session lookup at the route level.
    expect(mocks.getSession).not.toHaveBeenCalled();
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
