// @vitest-environment jsdom
/**
 * When a sign-in request never gets a response (offline, a dropped
 * connection, the server restarting during a deploy), the auth client throws
 * instead of returning `{ error }`. The page says so and stays usable rather
 * than resetting the button without a word.
 *
 * Mounted with the real auth client; only `fetch` is stood in.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
// better-auth's client keeps the `fetch` it finds when it is created.
vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init));

vi.mock('~/components', () => ({ Emoji: () => null }));
const captureHandledError = vi.fn();
vi.mock('~/utils/sentry.client', () => ({ captureHandledError }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: SignInPage } = await import('../SignInPage');
const { default: GitLabSignIn } = await import('../GitLabSignIn');

const UNREACHABLE = 'Could not reach Classmoji. Check your connection and try again.';

let container: HTMLDivElement;
let root: Root;

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 20)));

async function shownText(text: string) {
  for (let i = 0; i < 100 && !container.textContent?.includes(text); i++) await settle();
  expect(container.textContent).toContain(text);
}

async function shown(selector: string) {
  for (let i = 0; i < 100 && !container.querySelector(selector); i++) await settle();
  expect(container.querySelector(selector), selector).toBeTruthy();
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label);

const click = async (label: string) => {
  const el = button(label);
  expect(el, label).toBeTruthy();
  await act(async () => el!.click());
};

const type = async (selector: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const mount = (handleGitHubLogin: () => Promise<{ error?: unknown } | void>) =>
  act(async () =>
    root.render(
      <SignInPage handleGitHubLogin={handleGitHubLogin} callbackURL="/select-organization" />
    )
  );

beforeEach(() => {
  fetchMock.mockReset();
  captureHandledError.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('a sign-in request that gets no response', () => {
  it('Github: shows the message and enables the button again', async () => {
    await mount(() => Promise.reject(new TypeError('Failed to fetch')));

    await click('Continue with Github');
    await shownText(UNREACHABLE);
    expect(button('Continue with Github')?.disabled).toBe(false);
    // Reported, so a throw from a bug of ours is not hidden behind the line.
    expect(captureHandledError).toHaveBeenCalledWith(expect.any(TypeError), 'sign-in');
  });

  it('email: shows the message instead of failing silently', async () => {
    await mount(async () => {});
    await click('Continue with email');
    await shown('#auth-email');
    await type('#auth-email', 'someone@example.edu');
    await type('#auth-password', 'pw-12345678');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const form = container.querySelector('#auth-email')!.closest('form')!;
    await act(async () => form.requestSubmit());
    await shownText(UNREACHABLE);
    // The one request made was the sign-in, and it is the one that failed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/sign-in\/email$/);
  });

  it('email: an error status from the server is not "could not reach"', async () => {
    await mount(async () => {});
    await click('Continue with email');
    await shown('#auth-email');
    await type('#auth-email', 'someone@example.edu');
    await type('#auth-password', 'pw-12345678');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Invalid email or password' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );

    const form = container.querySelector('#auth-email')!.closest('form')!;
    await act(async () => form.requestSubmit());
    await shownText('Invalid email or password');
    expect(container.textContent).not.toContain(UNREACHABLE);
    expect(captureHandledError).not.toHaveBeenCalled();
  });

  it('Gitlab.com: says it could not start and enables the button again', async () => {
    await act(async () =>
      root.render(
        <GitLabSignIn
          options={{
            enabled: true,
            defaultHost: 'https://gitlab.com',
            preselected: null,
            unknownHost: null,
            pendingHost: null,
          }}
          callbackURL="/select-organization"
        />
      )
    );
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await click('Continue with Gitlab.com');
    await shownText('Could not start Gitlab sign-in.');
    expect(button('Continue with Gitlab.com')?.disabled).toBe(false);
    expect(captureHandledError).toHaveBeenCalledWith(expect.any(TypeError), 'sign-in');
  });

  it('a refusal the server sent still shows its own message', async () => {
    await mount(async () => ({ error: { message: 'Github sign-in is unavailable.' } }));

    await click('Continue with Github');
    await shownText('Github sign-in is unavailable.');
    expect(container.textContent).not.toContain(UNREACHABLE);
  });
});
