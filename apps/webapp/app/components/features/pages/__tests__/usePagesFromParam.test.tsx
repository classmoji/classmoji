// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { pagesHrefWithFrom, pagesOriginOf, usePagesFromParam } from '../usePagesFromParam';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Links into the pages app carry `?from=<the webapp page>` so the pages top bar
 * can send the reader back. Only links to the pages host are touched.
 */

const PAGES = 'https://pages.example.org';

describe('pagesHrefWithFrom', () => {
  it('adds from to a link on the pages host, keeping its own query', () => {
    expect(pagesHrefWithFrom(`${PAGES}/cs1/p-1`, PAGES, '/student/cs1/modules')).toBe(
      `${PAGES}/cs1/p-1?from=%2Fstudent%2Fcs1%2Fmodules`
    );
    expect(pagesHrefWithFrom(`${PAGES}/cs1/p-1?embed=true`, PAGES, '/a/b?x=1')).toBe(
      `${PAGES}/cs1/p-1?embed=true&from=%2Fa%2Fb%3Fx%3D1`
    );
  });

  it('replaces a from the link already had', () => {
    expect(pagesHrefWithFrom(`${PAGES}/cs1/p-1?from=%2Fold`, PAGES, '/new')).toBe(
      `${PAGES}/cs1/p-1?from=%2Fnew`
    );
  });

  it('leaves forms on the pages host alone (no top bar there)', () => {
    expect(pagesHrefWithFrom(`${PAGES}/cs1/forms/signup`, PAGES, '/a')).toBeNull();
    expect(pagesHrefWithFrom(`${PAGES}/cs1/forms`, PAGES, '/a')).toBeNull();
  });

  it('leaves every other host alone', () => {
    expect(pagesHrefWithFrom('https://github.com/x', PAGES, '/a')).toBeNull();
    expect(pagesHrefWithFrom('https://slides.example.org/s-1', PAGES, '/a')).toBeNull();
    expect(pagesHrefWithFrom('not a url', PAGES, '/a')).toBeNull();
  });
});

describe('pagesOriginOf', () => {
  it('is the origin of the configured URL, or null', () => {
    expect(pagesOriginOf('https://pages.example.org/some/path')).toBe(PAGES);
    expect(pagesOriginOf(null)).toBeNull();
    expect(pagesOriginOf('')).toBeNull();
    expect(pagesOriginOf('nope')).toBeNull();
  });
});

describe('usePagesFromParam', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const Harness = () => {
    usePagesFromParam(PAGES);
    return (
      <div>
        <a href={`${PAGES}/cs1/p-1`} target="_blank" rel="noreferrer">
          <span>page</span>
        </a>
        <a href="https://github.com/x">other</a>
      </div>
    );
  };

  it('rewrites a pages link at click time with the current location', () => {
    window.history.replaceState(null, '', '/student/cs1/modules?tab=all');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));

    const [pagesLink, otherLink] = Array.from(container.querySelectorAll('a'));
    // Stop the navigation itself; the capture listener still runs first.
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener('click', stop);
    pagesLink!.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    otherLink!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.removeEventListener('click', stop);

    // The navigation takes the rewritten href, synchronously…
    expect(pagesLink!.href).toBe(
      `${PAGES}/cs1/p-1?from=${encodeURIComponent('/student/cs1/modules?tab=all')}`
    );
    expect(otherLink!.href).toBe('https://github.com/x');
  });

  it('puts the plain link back afterwards, and ignores a right click', async () => {
    window.history.replaceState(null, '', '/student/cs1/modules');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));

    const pagesLink = container.querySelector('a')!;
    const plain = `${PAGES}/cs1/p-1`;
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener('click', stop);
    document.addEventListener('auxclick', stop);

    pagesLink.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pagesLink.href).not.toBe(plain);
    await new Promise(resolve => setTimeout(resolve, 0));
    // …and copying or hovering it later shows the plain link.
    expect(pagesLink.href).toBe(plain);

    pagesLink.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 2 }));
    expect(pagesLink.href).toBe(plain);

    pagesLink.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(pagesLink.href).toContain('from=');

    document.removeEventListener('click', stop);
    document.removeEventListener('auxclick', stop);
  });
});
