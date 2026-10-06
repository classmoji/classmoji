// @vitest-environment jsdom
/** A team picture that is missing, generic or fails to load shows the team's initial. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR_URL } from '@classmoji/utils';

const { default: TeamThumbnailView } = await import('../TeamThumbnailView');

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

const initial = () => container.querySelector('[aria-hidden]')?.textContent;

describe('TeamThumbnailView avatar', () => {
  it('swaps a picture that fails to load for the initial', async () => {
    await act(async () => {
      root.render(
        <TeamThumbnailView team={{ name: 'alpha', avatar_url: 'https://example.test/t.png' }} />
      );
    });
    expect(initial()).toBeUndefined();

    await act(async () => {
      container.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(initial()).toBe('A');
  });

  it('shows the initial for the generic default avatar', async () => {
    await act(async () => {
      root.render(<TeamThumbnailView team={{ name: 'beta', avatar_url: DEFAULT_AVATAR_URL }} />);
    });
    expect(container.querySelector('img')).toBeNull();
    expect(initial()).toBe('B');
  });
});
