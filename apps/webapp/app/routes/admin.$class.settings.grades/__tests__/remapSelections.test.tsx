// @vitest-environment jsdom
/**
 * The orphaned-grades remap keeps the owner's picks until the remap
 * succeeds: a refusal (returned as data) leaves them to correct and resend;
 * a success clears them. Mounted in jsdom against a stand-in for the shared
 * fetcher, whose state and data each rerender sets.
 */

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetcher = vi.hoisted(() => ({
  submit: vi.fn(),
  state: 'idle' as 'idle' | 'submitting' | 'loading',
  data: undefined as unknown,
}));

vi.mock('~/components', () => ({
  SettingSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Emoji: ({ emoji }: { emoji: string }) => <span>{emoji}</span>,
}));
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({ fetcher: { ...fetcher }, notify: vi.fn() }),
}));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/assets/images/token.png', () => ({ default: 'token.png' }));
vi.mock('../EmojiPicker', () => ({ default: () => null }));
// antd's Select lists its options in a virtual list jsdom never lays out: a
// native select stands in, with the same value / onChange / options.
vi.mock('antd', async importOriginal => ({
  ...(await importOriginal<typeof import('antd')>()),
  Select: ({
    value,
    onChange,
    options,
  }: {
    value?: string;
    onChange: (value: string) => void;
    options?: Array<{ value: string }>;
  }) => (
    <select data-testid="remap-select" value={value ?? ''} onChange={e => onChange(e.target.value)}>
      <option value="" />
      {options?.map(o => (
        <option key={o.value} value={o.value}>
          {o.value}
        </option>
      ))}
    </select>
  ),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: EmojiMapping } = await import('../EmojiMapping');

const MAPPINGS = [
  { emoji: 'score-90', grade: 90, extra_tokens: 0, description: '' },
  { emoji: 'score-80', grade: 80, extra_tokens: 0, description: '' },
];
const ORPHANS = [{ emoji: '+1', count: 2, quiz_count: 1 }];

let container: HTMLDivElement;
let root: Root;

const render = async () => {
  await act(async () => {
    root.render(<EmojiMapping emojiMappings={MAPPINGS} orphanedEmojis={ORPHANS} />);
  });
};

/** The fetcher moves on, and the page rerenders with it. */
const fetcherIs = async (state: typeof fetcher.state, data?: unknown) => {
  fetcher.state = state;
  fetcher.data = data;
  await render();
};

const remapButton = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Remap All'))!;

const pick = async (emoji: string) => {
  const select = container.querySelector<HTMLSelectElement>('[data-testid="remap-select"]')!;
  await act(async () => {
    select.value = emoji;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const remap = async () => {
  await act(async () => {
    remapButton().click();
  });
};

beforeEach(() => {
  fetcher.submit.mockReset();
  fetcher.state = 'idle';
  fetcher.data = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('remap picks', () => {
  it('stay after a refused remap and clear after a successful one', async () => {
    await render();
    expect(remapButton().disabled).toBe(true);
    await pick('score-90');
    expect(remapButton().disabled).toBe(false);

    await remap();
    expect(fetcher.submit).toHaveBeenCalledWith(
      { mappings: [{ oldEmoji: '+1', newEmoji: 'score-90' }] },
      expect.objectContaining({ action: '?/remapOrphanedEmojis' })
    );
    // Sent, not yet answered: the picks stay.
    expect(remapButton().disabled).toBe(false);

    await fetcherIs('submitting');
    await fetcherIs('idle', {
      action: 'REMAP_ORPHANED_EMOJIS',
      error: ':score-90: is not on this classroom’s scale.',
    });
    expect(remapButton().disabled).toBe(false);

    await remap();
    expect(fetcher.submit).toHaveBeenCalledTimes(2);
    await fetcherIs('submitting');
    await fetcherIs('loading', {
      action: 'REMAP_ORPHANED_EMOJIS',
      success: 'Remapped 2 grade(s).',
    });
    expect(remapButton().disabled).toBe(false);
    await fetcherIs('idle', { action: 'REMAP_ORPHANED_EMOJIS', success: 'Remapped 2 grade(s).' });
    expect(remapButton().disabled).toBe(true);
  });

  it("leave another action's answer on the shared fetcher alone", async () => {
    await render();
    await pick('score-80');
    await fetcherIs('submitting');
    await fetcherIs('idle', { action: 'SAVE_GRADING_SETTINGS', success: 'Saved.' });
    expect(remapButton().disabled).toBe(false);
  });
});
