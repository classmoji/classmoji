// @vitest-environment jsdom
/**
 * The View as banner's Stop, MOUNTED in jsdom, on a page whose address
 * carries the signed query of an app authorization (the consent page). The
 * auth client would add that query to the POST as `oauth_query`, and the
 * server would then refuse the stop (an expired query) or answer with an
 * error after it (a fresh one). So Stop is a plain POST with no body, and the
 * banner goes on to the page View as was started from.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const { default: ImpersonationBanner } = await import('../ImpersonationBanner');
const { rememberImpersonationReturn } = await import('~/utils/impersonationReturn');

const SESSION = { session: { impersonatedBy: 'admin-1' }, user: { name: 'Student One' } };

/** A consent page address with a signed query that expires at `exp` (seconds). */
const consentAddress = (exp: number) =>
  `/oauth/consent?client_id=c1&response_type=code&scope=read&exp=${exp}` +
  '&sig=c2lnbmF0dXJl&ba_param=client_id%2Cresponse_type%2Cscope%2Cexp';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  navigate.mockReset();
  fetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState({}, '', '/');
});

async function clickStop() {
  await act(async () => {
    root.render(<ImpersonationBanner session={SESSION} />);
  });
  const button = [...container.querySelectorAll('button')].find(b =>
    b.textContent?.includes('Stop viewing')
  );
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
  });
}

describe('the View as banner’s Stop', () => {
  const now = Math.floor(Date.now() / 1000);

  it.each([
    ['a fresh signed query', now + 600],
    ['an expired signed query', now - 600],
  ])('on a page with %s, sends a POST with no body and goes back', async (_label, exp) => {
    window.history.replaceState({}, '', consentAddress(exp));
    rememberImpersonationReturn('/admin/cs101/staff');
    fetchMock.mockResolvedValue(Response.json({ session: {}, user: { id: 'admin-1' } }));

    await clickStop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url), window.location.origin).pathname).toBe(
      '/api/auth/admin/stop-impersonating'
    );
    // No body: nothing carries the page's signed query.
    expect(init?.body).toBeUndefined();
    expect(init).toEqual({ method: 'POST', credentials: 'include' });
    expect(navigate).toHaveBeenCalledWith('/admin/cs101/staff');
  });

  it('stays on the page when the server refuses', async () => {
    window.history.replaceState({}, '', consentAddress(now + 600));
    fetchMock.mockResolvedValue(
      Response.json({ message: 'You are not impersonating anyone' }, { status: 400 })
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await clickStop();

    expect(navigate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      '[STOP_IMPERSONATE] Failed to stop impersonating:',
      expect.objectContaining({ message: 'You are not impersonating anyone' })
    );
    error.mockRestore();
  });
});
