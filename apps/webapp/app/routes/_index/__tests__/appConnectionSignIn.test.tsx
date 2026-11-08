// @vitest-environment jsdom
/**
 * Signing in while an MCP client's authorization waits (an app connection
 * started while signed out): the auth server sends the browser to the sign-in
 * page with the authorization's signed query in the address, and every
 * request the page makes through the REAL auth client (@classmoji/auth/client,
 * with `oauthProviderClient()`) carries it as `oauth_query`, so the sign-in
 * resumes the authorization. That includes the self-managed Gitlab sign-in,
 * which goes through the auth client for this.
 *
 * The signed query expires; the auth server then refuses any request that
 * carries it (`invalid_signature`). The page takes it out of the address and
 * says what to do, so the next attempt signs in. And a sign-in round trip the
 * auth server could not match (`?error=state_*`) gets a sentence of its own.
 *
 * Only `fetch` is stood in: these requests never leave the page.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
// better-auth's client keeps the `fetch` it finds when it is created.
vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init));

vi.mock('~/components', () => ({ Emoji: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { authClient } = await import('@classmoji/auth/client');
const { default: SignInPage } = await import('../SignInPage');
const { default: GitLabSignIn } = await import('../GitLabSignIn');
const { EXPIRED_APP_CONNECTION_MESSAGE } = await import('../signInRedirect');

/** An authorization's signed query as the auth server writes it (ba_param names what is signed). */
const SIGNED = new URLSearchParams([
  ['client_id', 'claude'],
  ['state', 'client-state'],
  ['scope', 'read write'],
  ['ba_param', 'ba_param'],
  ['ba_param', 'client_id'],
  ['ba_param', 'scope'],
  ['ba_param', 'state'],
  ['sig', 'signature-value'],
]);

/** The page's own parameters, which never travel with the sign-in. */
const PAGE_PARAMS = 'redirect=%2Finvite%3Fx%3D1';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The JSON body of the n-th request the page made. */
function sentBody(n = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[n]?.[1];
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

const sentPath = (n = 0) => new URL(String(fetchMock.mock.calls[n]?.[0])).pathname;

let container: HTMLDivElement;
let root: Root;

const mount = async (element: React.ReactElement) => {
  await act(async () => root.render(element));
};

const click = async (el: Element | null | undefined) => {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const button = (label: string) =>
  [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label);

/** Types into a controlled input the way a person does (React reads the native value). */
const type = async (selector: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const submit = async (selector: string) => {
  const form = container.querySelector(selector)!.closest('form')!;
  await act(async () => {
    form.requestSubmit();
  });
};

/** Lets the auth client's fetch, and the page's handling of it, settle. */
const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 20)));

/** Waits (through the screen change's animation) until `selector` is on the page. */
async function shown(selector: string) {
  for (let i = 0; i < 100 && !container.querySelector(selector); i++) await settle();
  expect(container.querySelector(selector), selector).toBeTruthy();
}

beforeEach(() => {
  fetchMock.mockReset();
  window.history.replaceState(null, '', `/?${PAGE_PARAMS}&${SIGNED}`);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, '', '/');
});

describe('the auth client while the address carries a signed authorization', () => {
  it('sends the signed query (and only it) with a sign-in', async () => {
    fetchMock.mockResolvedValue(json({ redirect: false, token: null }));

    await authClient.signIn.email({ email: 'a@example.edu', password: 'pw-123456' });

    const sent = new URLSearchParams(String(sentBody().oauth_query));
    expect([...sent.keys()].sort()).toEqual(
      ['ba_param', 'ba_param', 'ba_param', 'ba_param', 'client_id', 'scope', 'sig', 'state'].sort()
    );
    expect(sent.get('client_id')).toBe('claude');
    expect(sent.has('redirect')).toBe(false);
  });

  it('sends nothing extra from an address without one', async () => {
    window.history.replaceState(null, '', `/?${PAGE_PARAMS}`);
    fetchMock.mockResolvedValue(json({ redirect: false, token: null }));

    await authClient.signIn.email({ email: 'a@example.edu', password: 'pw-123456' });

    expect(sentBody()).not.toHaveProperty('oauth_query');
  });

  it('sends it with a self-managed Gitlab sign-in', async () => {
    fetchMock.mockResolvedValue(json({ url: 'https://gitlab.school.edu/oauth/authorize' }, 400));
    await mount(
      <GitLabSignIn
        options={{
          enabled: true,
          defaultHost: null,
          preselected: { id: 'inst-1', host: 'https://gitlab.school.edu' },
          unknownHost: null,
          pendingHost: null,
        }}
        callbackURL="/select-organization"
      />
    );

    await click(button('Continue with gitlab.school.edu'));
    await settle();

    expect(sentPath()).toBe('/api/auth/gitlab-instance/sign-in');
    expect(sentBody()).toMatchObject({
      instanceId: 'inst-1',
      callbackURL: '/select-organization',
      oauth_query: expect.stringContaining('sig=signature-value'),
    });
  });
});

describe('a signed authorization that has expired', () => {
  const EXPIRED = () => json({ error: 'invalid_signature' }, 400);

  it('is taken out of the address after a refused email sign-in, and the next try goes without it', async () => {
    await mount(
      <SignInPage handleGitHubLogin={async () => {}} callbackURL="/select-organization" />
    );
    await click(button('Continue with email'));
    await shown('#auth-email');
    await type('#auth-email', 'a@example.edu');
    await type('#auth-password', 'pw-123456');
    fetchMock.mockResolvedValueOnce(EXPIRED());

    await submit('#auth-email');
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      EXPIRED_APP_CONNECTION_MESSAGE
    );
    // The page's own parameters stay.
    expect(window.location.search).toBe(`?${PAGE_PARAMS}`);

    fetchMock.mockResolvedValueOnce(json({ redirect: false, token: null }));
    await submit('#auth-email');
    await settle();
    expect(sentBody(1)).not.toHaveProperty('oauth_query');
  });

  it('is reported for the Github button too', async () => {
    await mount(
      <SignInPage
        handleGitHubLogin={async () => ({ error: { status: 400, error: 'invalid_signature' } })}
        callbackURL="/select-organization"
      />
    );

    await click(button('Continue with Github'));
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      EXPIRED_APP_CONNECTION_MESSAGE
    );
    expect(window.location.search).toBe(`?${PAGE_PARAMS}`);
  });

  it('is reported for a self-managed Gitlab sign-in', async () => {
    fetchMock.mockResolvedValueOnce(EXPIRED());
    await mount(
      <GitLabSignIn
        options={{
          enabled: true,
          defaultHost: null,
          preselected: { id: 'inst-1', host: 'https://gitlab.school.edu' },
          unknownHost: null,
          pendingHost: null,
        }}
        callbackURL="/select-organization"
      />
    );

    await click(button('Continue with gitlab.school.edu'));
    await settle();

    expect(container.querySelector('#gitlab-host-status')?.textContent).toBe(
      EXPIRED_APP_CONNECTION_MESSAGE
    );
    expect(window.location.search).toBe(`?${PAGE_PARAMS}`);
    // Not taken for an unknown instance: no host lookup followed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a sign-in round trip the auth server could not match', () => {
  it.each([['state_mismatch'], ['state_not_found'], ['state_invalid'], ['please_restart_the_process']])(
    '?error=%s gets its own sentence',
    code => {
      const html = renderToStaticMarkup(
        <SignInPage
          handleGitHubLogin={async () => {}}
          callbackURL="/select-organization"
          oauthError={code}
        />
      );
      expect(html).toContain('Sign-in didn&#x27;t go through. Please try again.');
      expect(html).not.toContain('Sign-in failed. Please try again.');
    }
  );
});
