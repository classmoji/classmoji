// @vitest-environment jsdom
/**
 * The grade options. In the hover picker (default) any grader's grade marks
 * its emoji selected and a click removes it, as before. With
 * `viewerGradesOnly` (the submission panel, which lists the other graders'
 * grades on their own) only the viewer's own grades count: a click on an
 * emoji another grader gave adds the viewer's grade instead of deleting
 * theirs. `disabled` makes every option inert.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.fn();
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({ fetcher: { submit }, notify: vi.fn() }),
  useUser: () => ({ user: { id: 'me' } }),
}));
vi.mock('~/store', () => ({ default: () => ({ classroom: { slug: 'intro' } }) }));
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span>{emoji}</span>,
}));

const { default: EmojiGradeOptions } = await import('../EmojiGradeOptions');

const SUBMISSION = {
  id: 'sub-1',
  assignment_id: 'a-1',
  studentId: 'ada',
  grades: [
    { id: 'g-ta', emoji: 'star', grader_id: 'ta' },
    { id: 'g-me', emoji: 'ok', grader_id: 'me' },
  ],
  repository: { name: 'lab-ada' },
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  submit.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = async (props: { viewerGradesOnly?: boolean; disabled?: boolean } = {}) => {
  await act(async () => {
    root.render(
      <EmojiGradeOptions
        repositoryAssignment={SUBMISSION}
        emojiMappings={{ star: 100, ok: 70, meh: 50 }}
        {...props}
      />
    );
  });
};
const option = (emoji: string) =>
  container.querySelector(`[data-testid="emoji-grade-option-${emoji}"]`) as HTMLElement;
const click = async (emoji: string) => {
  await act(async () => {
    (option(emoji).querySelector('button') as HTMLButtonElement).click();
  });
};
const sent = () => submit.mock.calls[0];

describe('EmojiGradeOptions', () => {
  it("marks and removes any grader's grade by default (the hover picker)", async () => {
    await mount();
    expect(option('star').dataset.selected).toBe('true');
    expect(option('ok').dataset.selected).toBe('true');

    await click('star');
    expect(sent()[1].action).toBe('/api/gitRepoAssignment/intro?action=removeGrade');
    expect(sent()[0].grade).toMatchObject({ id: 'g-ta' });
  });

  it("marks and removes only the viewer's own grades with viewerGradesOnly", async () => {
    await mount({ viewerGradesOnly: true });
    expect(option('star').dataset.selected).toBe('false');
    expect(option('ok').dataset.selected).toBe('true');

    // Another grader's emoji: adds the viewer's grade, never removes theirs.
    await click('star');
    expect(sent()[1].action).toBe('/api/gitRepoAssignment/intro?action=addGrade');
    expect(sent()[0].grade).toBe('star');

    submit.mockReset();
    await click('ok');
    expect(sent()[1].action).toBe('/api/gitRepoAssignment/intro?action=removeGrade');
    expect(sent()[0].grade).toMatchObject({ id: 'g-me' });
  });

  it('sends nothing while disabled', async () => {
    await mount({ viewerGradesOnly: true, disabled: true });
    await click('meh');
    expect(submit).not.toHaveBeenCalled();
  });
});
