/**
 * Releasing final grades from the gradebook while its breakpoints are edited.
 *
 * The Breakpoints popover edits letter cutoffs in the page only (never saved),
 * and students' final grades read the SAVED cutoffs. So while the two differ,
 * the Letter column is not what students would get: Release is disabled.
 * Hiding released grades stays available. Rendered on the server.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LetterGradeMappingEntry } from '@classmoji/utils';

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useFetcher: () => ({ state: 'idle', submit: vi.fn(), json: undefined, data: undefined }),
}));
vi.mock('~/components/features/grading/EmojiGrader', () => ({ default: () => null }));
vi.mock('~/components', () => ({ UserThumbnailView: () => null }));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));

const { default: FinalGradesControl } = await import('../FinalGradesControl');
const { breakpointsEdited } = await import('../GradesTable');

const SAVED: LetterGradeMappingEntry[] = [
  { letter_grade: 'A', min_grade: 90 },
  { letter_grade: 'B', min_grade: 80 },
  { letter_grade: 'C', min_grade: 70 },
];

describe('breakpointsEdited', () => {
  it('is false for the saved cutoffs, whatever their order or identity', () => {
    expect(breakpointsEdited(SAVED, SAVED)).toBe(false);
    expect(breakpointsEdited(SAVED, SAVED.map(m => ({ ...m })).reverse())).toBe(false);
    expect(breakpointsEdited([], [])).toBe(false);
  });

  it('is true once a cutoff differs, including a cleared (NaN) one', () => {
    const edit = (min: number) =>
      SAVED.map(m => (m.letter_grade === 'B' ? { ...m, min_grade: min } : m));
    expect(breakpointsEdited(SAVED, edit(85))).toBe(true);
    expect(breakpointsEdited(SAVED, edit(NaN))).toBe(true);
    // Put back as saved: releasable again.
    expect(breakpointsEdited(SAVED, edit(80))).toBe(false);
  });

  it('is true when the letters themselves differ', () => {
    expect(breakpointsEdited(SAVED, SAVED.slice(1))).toBe(true);
    expect(
      breakpointsEdited(SAVED, [...SAVED.slice(1), { letter_grade: 'A+', min_grade: 90 }])
    ).toBe(true);
  });
});

describe('FinalGradesControl', () => {
  const render = (released: boolean, edited: boolean) =>
    renderToStaticMarkup(
      <FinalGradesControl
        released={released}
        canRelease
        breakpointsEdited={edited}
        actionPath="/admin/intro-101/grades"
      />
    );

  /** Whether the release/hide button carries the disabled attribute (not the class). */
  const disabled = (html: string) => /<button[^>]*\sdisabled=""/.test(html);

  it('offers Release while the breakpoints are the saved ones', () => {
    const html = render(false, false);

    expect(html).toContain('Release final grades');
    expect(disabled(html)).toBe(false);
  });

  it('disables Release while the breakpoints are edited here', () => {
    const html = render(false, true);

    expect(html).toContain('Release final grades');
    expect(disabled(html)).toBe(true);
  });

  it('keeps Hide available whatever the breakpoints', () => {
    const html = render(true, true);

    expect(html).toContain('Hide final grades');
    expect(disabled(html)).toBe(false);
  });
});
