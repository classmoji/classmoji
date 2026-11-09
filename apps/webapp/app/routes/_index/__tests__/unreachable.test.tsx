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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: SignInPage } = await import('../SignInPage');

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
  });

  it('a refusal the server sent still shows its own message', async () => {
    await mount(async () => ({ error: { message: 'Github sign-in is unavailable.' } }));

    await click('Continue with Github');
    await shownText('Github sign-in is unavailable.');
    expect(container.textContent).not.toContain(UNREACHABLE);
  });
});
