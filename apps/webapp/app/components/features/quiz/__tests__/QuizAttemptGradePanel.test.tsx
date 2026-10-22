// @vitest-environment jsdom
/**
 * The staff attempt drawer's grade blocks, rendered in a data router:
 *
 *   - resolving the open request in its banner shows the toast after the
 *     banner has gone (the loader revalidates without the request), because
 *     the toast lives in `QuizResolveToast`, which stays mounted;
 *   - a read-only classroom (no `panel` on the banner) shows the request with
 *     a "View in Regrade/Resubmit Requests" link to the queue, and no
 *     "Resolve" wording or form anywhere;
 *   - the picker marks the attempt's current grade "current", and picking it
 *     says it keeps the score (the resolve button then reads "Keep score").
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffAttemptGradePanel } from '~/utils/quizPayloads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const callout = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => callout }));
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span data-emoji={emoji} />,
}));

const { QuizAttemptGradePanel, QuizRegradeRequestBanner, QuizResolveToast } =
  await import('../QuizAttemptGradePanel');

const panel = (over: Partial<StaffAttemptGradePanel> = {}): StaffAttemptGradePanel => ({
  attemptId: 'att-1',
  adjustable: true,
  canEdit: true,
  grade: {
    emoji: 'eyes',
    originalEmoji: null,
    adjusted: false,
    band: null,
    lateHours: null,
    countedEmoji: null,
    countsTowardGrade: null,
  },
  adjustedEmoji: null,
  comment: null,
  adjustedByName: null,
  adjustedAt: null,
  commentByName: null,
  commentAt: null,
  scaleEmojis: ['rocket', '+1', 'eyes', '-1'],
  countedByEmoji: { rocket: 'rocket', '+1': '+1', eyes: 'eyes', '-1': '-1' },
  openRequest: {
    id: 'req-1',
    comment: 'Q2 was right.',
    studentName: 'Ada',
    createdAt: '2026-10-20T10:00:00.000Z',
  },
  ...over,
});

/** The drawer's `beforeResults` slot, as the route renders it. */
function Blocks() {
  const p = useLoaderData() as StaffAttemptGradePanel;
  return (
    <>
      <QuizResolveToast attemptId={p.attemptId} />
      {p.openRequest && (
        <QuizRegradeRequestBanner
          request={p.openRequest}
          queueUrl={
            p.canEdit
              ? `/admin/cs1/regrade-requests?resolve=${p.openRequest.id}`
              : '/admin/cs1/regrade-requests'
          }
          panel={p.canEdit ? p : null}
        />
      )}
      {p.adjustable && <QuizAttemptGradePanel panel={p} />}
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  callout.show.mockClear();
  // antd reads matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = async (
  loader: () => StaffAttemptGradePanel,
  action: (body: unknown) => unknown = () => ({})
) => {
  const router = createMemoryRouter(
    [
      {
        path: '/admin/:class/quizzes/:quizId/attempt/:attemptId',
        loader,
        action: async ({ request }) => action(await request.json()),
        element: <Blocks />,
      },
    ],
    { initialEntries: ['/admin/cs1/quizzes/quiz-1/attempt/att-1'] }
  );
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  return router;
};

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const click = async (el: Element | null) => {
  if (!el) throw new Error('missing element');
  await act(async () => {
    (el as HTMLElement).click();
  });
};
const type = async (el: Element | null, value: string) => {
  if (!el) throw new Error('missing element');
  const input = el as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

describe('the drawer resolve toast', () => {
  it('shows after the banner is gone, from the component that stays mounted', async () => {
    let open = true;
    const bodies: unknown[] = [];
    await mount(
      () => panel({ openRequest: open ? panel().openRequest : null }),
      body => {
        bodies.push(body);
        open = false;
        return { success: 'Score adjusted' };
      }
    );

    expect(byTestId('quiz-regrade-banner')).not.toBeNull();
    await click(byTestId('quiz-emoji-option-+1'));
    await type(byTestId('quiz-resolve-reply'), 'Adjusted.');
    await click(byTestId('quiz-regrade-resolve-submit'));
    await settle();

    expect(bodies).toEqual([
      expect.objectContaining({ _action: 'resolve', requestId: 'req-1', resolution: 'APPROVED' }),
    ]);
    // The request is resolved: the banner is gone, the toast still shows.
    expect(byTestId('quiz-regrade-banner')).toBeNull();
    expect(callout.show).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'success', title: 'Score adjusted' })
    );
  });

  it('does not toast an old result on mount', async () => {
    await mount(() => panel());
    expect(callout.show).not.toHaveBeenCalled();
  });
});

describe('a read-only classroom', () => {
  it('shows the request with a View link to the queue, and no Resolve anywhere', async () => {
    await mount(() => panel({ canEdit: false }));
    const banner = byTestId('quiz-regrade-banner');
    expect(banner?.textContent).toContain('Q2 was right.');
    const link = byTestId('quiz-regrade-banner-link') as HTMLAnchorElement;
    expect(link.textContent).toBe('View in Regrade/Resubmit Requests');
    expect(link.getAttribute('href')).toBe('/admin/cs1/regrade-requests');
    expect(container.textContent).not.toMatch(/Resolve/);
    expect(byTestId('quiz-regrade-resolve')).toBeNull();
    expect(byTestId('quiz-adjust-open')).toBeNull();
  });
});

describe('the picker marks the current grade', () => {
  it('in the banner: "current", and picking it keeps the score', async () => {
    await mount(() => panel());
    const current = byTestId('quiz-emoji-option-eyes');
    expect(current?.querySelector('[data-testid="quiz-emoji-current"]')?.textContent).toBe(
      'current'
    );
    expect(container.querySelectorAll('[data-testid="quiz-emoji-current"]')).toHaveLength(1);

    await click(current);
    expect(byTestId('quiz-resolve-keeps')?.textContent).toMatch(/keeps the score/);
    expect(byTestId('quiz-regrade-resolve-submit')?.textContent).toBe('Keep score');

    await click(byTestId('quiz-emoji-option-+1'));
    expect(byTestId('quiz-resolve-keeps')).toBeNull();
    expect(byTestId('quiz-regrade-resolve-submit')?.textContent).toBe('Adjust score');
  });

  it('in the adjust panel too', async () => {
    await mount(() => panel({ openRequest: null }));
    await click(byTestId('quiz-adjust-open'));
    const panelEl = byTestId('quiz-adjust-panel');
    expect(
      panelEl?.querySelector(
        '[data-testid="quiz-emoji-option-eyes"] [data-testid="quiz-emoji-current"]'
      )
    ).not.toBeNull();
    await click(panelEl!.querySelector('[data-testid="quiz-emoji-option-eyes"]'));
    expect(byTestId('quiz-adjust-keeps')?.textContent).toMatch(/keeps the score/);
  });
});
