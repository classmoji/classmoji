// @vitest-environment jsdom
/**
 * The code screen after an email sign-up points to "Reset your password": a
 * sign-up for an address that already has an account keeps no password from
 * it (@classmoji/auth/server, resetUnverifiedPasswordAccount), so whoever
 * owns the address sets one that way. After a sign-in that needs the address
 * verified first, the password was just accepted, and the screen doesn't.
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let container: HTMLDivElement;
let root: Root;

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 20)));

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

const submit = async (selector: string) => {
  const form = container.querySelector(selector)!.closest('form')!;
  await act(async () => form.requestSubmit());
};

beforeEach(async () => {
  fetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<SignInPage handleGitHubLogin={async () => {}} callbackURL="/select-organization" />)
  );
  await click('Continue with email');
  await shown('#auth-email');
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the code screen', () => {
  it('after a sign-up, points to Reset your password, which opens the reset form', async () => {
    await click('Create an account');
    await shown('#auth-name');
    await type('#auth-name', 'Someone');
    await type('#auth-email', 'someone@example.edu');
    await type('#auth-new-password', 'pw-12345678');
    await type('#auth-confirm-password', 'pw-12345678');
    // Sign-up, then the code it asks for.
    fetchMock.mockResolvedValueOnce(json({ token: null, user: { id: 'x' } }));
    fetchMock.mockResolvedValueOnce(json({ success: true }));

    await submit('#auth-name');
    await shown('#auth-code');

    expect(container.textContent).toContain('Already have an account with this email?');
    await click('Reset your password');
    await shown('#auth-email');
    expect(container.textContent).toContain('Send reset code');
    expect(container.querySelector<HTMLInputElement>('#auth-email')?.value).toBe(
      'someone@example.edu'
    );
  });

  it('after a sign-in that needs the address verified, does not', async () => {
    await type('#auth-email', 'someone@example.edu');
    await type('#auth-password', 'pw-12345678');
    fetchMock.mockResolvedValueOnce(json({ message: 'Email not verified' }, 403));

    await submit('#auth-email');
    await shown('#auth-code');

    expect(container.textContent).not.toContain('Already have an account with this email?');
    expect(button('Reset your password')).toBeUndefined();
  });
});
