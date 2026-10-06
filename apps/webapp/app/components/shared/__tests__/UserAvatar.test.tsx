// @vitest-environment jsdom
/**
 * UserAvatar draws initials for a user without a real picture: no image, the
 * database's generic DEFAULT_AVATAR_URL, or a URL that fails to load (#374).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR_URL } from '@classmoji/utils';

const { default: UserAvatar } = await import('../UserAvatar');

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

const render = async (el: React.ReactElement) => {
  await act(async () => root.render(el));
};

describe('UserAvatar', () => {
  it('shows the picture when there is a real image', async () => {
    await render(<UserAvatar image="https://example.test/a.png" name="Sam Rivera" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/a.png');
  });

  it('treats the default avatar URL as no image', async () => {
    await render(<UserAvatar image={DEFAULT_AVATAR_URL} name="Sam Rivera" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('SR');
  });

  it('skips words that do not start with a letter or digit', async () => {
    await render(<UserAvatar image={null} name="Avery (TA)" />);
    expect(container.textContent).toBe('A');
  });

  it('falls back to the login when there is no name', async () => {
    await render(<UserAvatar image={null} login="example-ta" />);
    expect(container.textContent).toBe('E');
  });

  it('gives a new image its own chance after an earlier one failed', async () => {
    await render(<UserAvatar image="https://example.test/dead.png" name="Sam Rivera" />);
    await act(async () => {
      container.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();

    await render(<UserAvatar image="https://example.test/live.png" name="Sam Rivera" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/live.png'
    );
  });
});
