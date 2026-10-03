/**
 * When the Extend popover offers itself, what it starts at, and what it posts.
 * The row decides whether Extend is offered at all; the popover needs a price
 * per hour. The hours field starts at the hours that clear the lateness and never offers more
 * than the balance pays for. A purchase names its target: the repo submission
 * or the quiz assignment. Rendered on the server with the popover's content
 * inline.
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
// Only the type is imported; keep the services package out of this render.
vi.mock('@classmoji/services', () => ({}));
vi.mock('use-sound', () => ({ default: () => [vi.fn()] }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/hooks', () => ({
  useNotifiedFetcher: () => ({ fetcher: { data: null, submit: vi.fn() }, notify: vi.fn() }),
  useUser: () => ({ user: { id: 'student-1' } }),
}));
vi.mock('~/store', () => ({ default: () => ({ classroom: { id: 'class-1' } }) }));
vi.mock('~/assets/images/token.png', () => ({ default: 'token.png' }));
vi.mock('~/assets/sounds/coins.mp3', () => ({ default: 'coins.mp3' }));

const { default: TokenExtensionPopover, extensionTargetBody } =
  await import('../TokenExtensionPopover');

const render = (
  over: { suggested_hours?: number; tokens_per_hour?: number },
  balance: number | null = 10
) =>
  renderToStaticMarkup(
    <TokenExtensionPopover
      target={{ kind: 'REPO', gitRepoAssignmentId: 'gra-1' }}
      suggestedHours={over.suggested_hours ?? 0}
      tokensPerHour={over.tokens_per_hour ?? 2}
      balance={balance}
    />
  );

describe('TokenExtensionPopover', () => {
  it('offers itself on work that is not late (before the deadline, or submitted on time)', () => {
    const html = render({ suggested_hours: 0 });

    expect(html).toContain('data-popover');
    expect(html).toContain('1 hour(s) = 2 tokens');
    // 10 tokens at 2 an hour: five hours at most.
    expect(html).toContain('data-max="5"');
  });

  it('starts at the suggested hours, down to what the balance pays for', () => {
    expect(render({ suggested_hours: 3 })).toContain('3 hour(s) = 6 tokens');

    const capped = render({ suggested_hours: 8 });
    expect(capped).toContain('5 hour(s) = 10 tokens');
    expect(capped).toContain('data-hours="5"');
  });

  it('disables the purchase when the balance pays for no hour', () => {
    const html = render({ suggested_hours: 4 }, 1);

    expect(html).toContain('1 hour(s) = 2 tokens');
    expect(html).toContain('<button disabled="">Purchase</button>');
  });

  it('is absent without a price per hour', () => {
    expect(render({ tokens_per_hour: 0 })).toBe('');
  });

  it('works the same on a quiz assignment', () => {
    const html = renderToStaticMarkup(
      <TokenExtensionPopover
        target={{ kind: 'QUIZ', assignmentId: 'asg-q' }}
        suggestedHours={3}
        tokensPerHour={1}
        balance={10}
      />
    );
    expect(html).toContain('3 hour(s) = 3 tokens');
  });

  it('posts the submission id for a repo and the assignment id for a quiz', () => {
    expect(extensionTargetBody({ kind: 'REPO', gitRepoAssignmentId: 'gra-1' })).toEqual({
      git_repo_assignment_id: 'gra-1',
    });
    expect(extensionTargetBody({ kind: 'QUIZ', assignmentId: 'asg-q' })).toEqual({
      assignment_id: 'asg-q',
    });
  });
});
