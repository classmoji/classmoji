// @vitest-environment jsdom
/**
 * Issue #374: the example students (and any user whose avatar URL 404s, e.g.
 * a deleted GitHub account) showed the browser's broken-image icon forever,
 * because the bare <img> had no error handling. UserThumbnailView now
 * delegates to UserAvatar, which tracks load failures and swaps to an
 * initials bubble — this asserts that swap actually happens on a real
 * `error` event, and that a user with no avatar_url never gets an <img> at
 * all (so the broken-image icon can't appear either way).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { default: UserThumbnailView } = await import('../UserThumbnailView');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('UserThumbnailView avatar fallback', () => {
  it('swaps a broken avatar_url for initials instead of showing a broken image', async () => {
    await act(async () => {
      root.render(
        <UserThumbnailView
          user={{
            avatar_url: 'https://github.com/identicons/example-student-1.png',
            name: 'Sam Rivera',
            login: 'example-student-1',
          }}
        />
      );
    });

    const img = container.querySelector('img');
    if (!img) throw new Error('expected an <img> before the error event');
    expect(container.textContent).not.toContain('SR');

    await act(async () => {
      img.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('SR');
  });

  it('renders initials, never a broken <img>, when there is no avatar_url', async () => {
    await act(async () => {
      root.render(<UserThumbnailView user={{ name: 'Priya Shah', login: 'example-student-2' }} />);
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('PS');
  });
});
