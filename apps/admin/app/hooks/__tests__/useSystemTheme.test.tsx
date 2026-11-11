// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSystemTheme } from '../useSystemTheme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let osDark = true;
let listeners: ((e: { matches: boolean }) => void)[] = [];

beforeEach(() => {
  osDark = true;
  listeners = [];
  window.matchMedia = ((query: string) => ({
    get matches() {
      return osDark;
    },
    media: query,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      listeners = listeners.filter(l => l !== fn);
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  document.documentElement.className = '';
});

// The root renders the whole document, as apps/admin/app/root.tsx does.
const Page = ({ text }: { text: string }) => {
  useSystemTheme();
  return (
    <html lang="en">
      <head />
      <body>
        <p>{text}</p>
      </body>
    </html>
  );
};

/** Server HTML, plus what the pre-paint THEME_SCRIPT leaves on <html>. */
const loadServerPage = (text: string) => {
  document.open();
  document.write(`<!DOCTYPE html>${renderToString(<Page text={text} />)}`);
  document.close();
  document.documentElement.classList.add('dark');
  document.documentElement.setAttribute('data-theme', 'dark');
};

describe('useSystemTheme', () => {
  it('keeps dark mode when a hydration mismatch makes React re-render the document', async () => {
    // A date the Worker formats in UTC and the browser in Eastern time.
    loadServerPage('Updated 6:00 PM');
    const recovered: unknown[] = [];

    await act(async () => {
      hydrateRoot(document, <Page text="Updated 1:00 PM" />, {
        onRecoverableError: e => recovered.push(e),
      });
    });

    // The mismatch really did throw the server HTML away...
    expect(recovered.length).toBeGreaterThan(0);
    // ...and the page is still dark afterwards.
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('follows the OS when it switches between light and dark', async () => {
    loadServerPage('same');
    await act(async () => {
      hydrateRoot(document, <Page text="same" />);
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    osDark = false;
    listeners.forEach(l => l({ matches: false }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    osDark = true;
    listeners.forEach(l => l({ matches: true }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
