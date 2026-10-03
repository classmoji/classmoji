/**
 * When the Extend popover offers itself and what it starts at. Hours sell at
 * any time, so neither the deadline nor how late the work is decides whether
 * it shows: only a price per hour and the absence of a late override do. The
 * hours field starts at the late hours and never offers more than the balance
 * pays for. Rendered on the server with the popover's content inline.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('antd', () => ({
  Popover: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <div data-popover>
      {children}
      {content}
    </div>
  ),
  InputNumber: ({ value, max }: { value: number; max?: number }) => (
    <input data-hours={value} data-max={max ?? 'none'} readOnly />
  ),
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
}));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
vi.mock('use-sound', () => ({ default: () => [vi.fn()] }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/hooks', () => ({
  useNotifiedFetcher: () => ({ fetcher: { data: null, submit: vi.fn() }, notify: vi.fn() }),
  useUser: () => ({ user: { id: 'student-1' } }),
}));
vi.mock('~/store', () => ({ default: () => ({ classroom: { id: 'class-1' } }) }));
vi.mock('~/assets/images/token.png', () => ({ default: 'token.png' }));
vi.mock('~/assets/sounds/coins.mp3', () => ({ default: 'coins.mp3' }));

const { default: TokenExtensionPopover } = await import('../TokenExtensionPopover');

const render = (
  over: { num_late_hours?: number; is_late_override?: boolean; tokens_per_hour?: number | null },
  balance: number | null = 10
) =>
  renderToStaticMarkup(
    <TokenExtensionPopover
      repositoryAssignment={{
        id: 'gra-1',
        num_late_hours: over.num_late_hours ?? 0,
        is_late_override: over.is_late_override ?? false,
        assignment: { tokens_per_hour: 'tokens_per_hour' in over ? over.tokens_per_hour : 2 },
      }}
      balance={balance}
    />
  );

describe('TokenExtensionPopover', () => {
  it('offers itself on work that is not late (before the deadline, or submitted on time)', () => {
    const html = render({ num_late_hours: 0 });

    expect(html).toContain('data-popover');
    expect(html).toContain('1 hour(s) = 2 tokens');
    // 10 tokens at 2 an hour: five hours at most.
    expect(html).toContain('data-max="5"');
  });

  it('starts at the late hours, down to what the balance pays for', () => {
    expect(render({ num_late_hours: 3 })).toContain('3 hour(s) = 6 tokens');

    const capped = render({ num_late_hours: 8 });
    expect(capped).toContain('5 hour(s) = 10 tokens');
    expect(capped).toContain('data-hours="5"');
  });

  it('disables the purchase when the balance pays for no hour', () => {
    const html = render({ num_late_hours: 4 }, 1);

    expect(html).toContain('1 hour(s) = 2 tokens');
    expect(html).toContain('<button disabled="">Purchase</button>');
  });

  it('is absent without a price per hour, or with a late override', () => {
    expect(render({ tokens_per_hour: 0 })).toBe('');
    expect(render({ tokens_per_hour: null })).toBe('');
    expect(render({ num_late_hours: 4, is_late_override: true })).toBe('');
  });
});
