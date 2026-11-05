// @vitest-environment jsdom
/**
 * The repo submission's shield after its move onto `LateShieldButton` (#813):
 * it posts the same body to the same target as before, and shows only on a
 * late or already-exempt submission.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetcher = vi.hoisted(() => ({ submit: vi.fn(), notify: vi.fn() }));
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({
    fetcher: { submit: fetcher.submit, data: undefined },
    notify: fetcher.notify,
  }),
}));
vi.mock('~/store', () => ({ default: () => ({ classroom: { slug: 'cs1' } }) }));

const { default: LateOverrideButton } = await import('../LateOverrideButton');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetcher.submit.mockClear();
  fetcher.notify.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async (ra: { is_late: boolean; is_late_override: boolean }) => {
  await act(async () => {
    root.render(<LateOverrideButton repositoryAssignment={{ id: 'gra-1', ...ra }} />);
  });
  return container.querySelector('button');
};

describe('LateOverrideButton (repo shield)', () => {
  it('renders nothing on an on-time submission with no exemption', async () => {
    expect(await render({ is_late: false, is_late_override: false })).toBeNull();
  });

  it('posts the same body and target as before to add the exemption on a late one', async () => {
    const button = await render({ is_late: true, is_late_override: false });
    expect(button?.getAttribute('aria-label')).toBe('Add late override');

    await act(async () => button!.click());

    expect(fetcher.notify).toHaveBeenCalledWith('update-late-override', 'Adding late override');
    expect(fetcher.submit).toHaveBeenCalledExactlyOnceWith(
      { git_repo_assignment_id: 'gra-1', is_late_override: true },
      {
        method: 'post',
        action: '/api/gitRepoAssignment/cs1?action=updateLateOverride',
        encType: 'application/json',
      }
    );
  });

  it('shows on an exempt submission even when no longer late, and clears it', async () => {
    const button = await render({ is_late: false, is_late_override: true });
    expect(button?.getAttribute('aria-label')).toBe('Remove late override');

    await act(async () => button!.click());

    expect(fetcher.submit).toHaveBeenCalledWith(
      { git_repo_assignment_id: 'gra-1', is_late_override: false },
      expect.objectContaining({ action: '/api/gitRepoAssignment/cs1?action=updateLateOverride' })
    );
  });
});
