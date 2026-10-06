// @vitest-environment jsdom
/** Student avatars on the dashboard leaderboard fall back to initials (#374). */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR_URL } from '@classmoji/utils';

const { default: Leaderboard } = await import('../Leaderboard');

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

describe('Leaderboard avatars', () => {
  it('draws initials for the default avatar and for a picture that fails to load', async () => {
    await act(async () => {
      root.render(
        <Leaderboard
          students={[
            { id: '1', grade: 90, name: 'Sam Rivera', avatar_url: 'https://example.test/dead.png' },
            { id: '2', grade: 80, name: 'Priya Shah', avatar_url: DEFAULT_AVATAR_URL },
          ]}
        />
      );
    });
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(container.textContent).toContain('PS');

    await act(async () => {
      imgs[0].dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('SR');
  });
});
