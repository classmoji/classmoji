/**
 * The grade line at the bottom of the dashboard's "Recent feedback" panel:
 * "Final grade" with the letter alone once final grades are released, else
 * the estimate (a letter or an emoji, never a percentage), else nothing.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { StudentGradeSummary } from '@classmoji/utils';

const { default: RetroTabsCard } = await import('../RetroTabsCard');

const render = (gradeSummary: StudentGradeSummary | null) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <RetroTabsCard
        feedback={[]}
        team={null}
        needsTeam={null}
        resubmits={[]}
        gradeSummary={gradeSummary}
        classSlug="intro-101"
      />
    </MemoryRouter>
  );

/** The visible text, tags stripped. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('RetroTabsCard grade line', () => {
  it('shows "Final grade" and the letter alone once final grades are released', () => {
    const shown = text(render({ kind: 'final', letter: 'A-' }));

    expect(shown).toContain('Final grade A-');
    expect(shown).not.toContain('Estimated');
    expect(shown).not.toContain('instructor');
    expect(shown).not.toContain('%');
  });

  it('shows the estimated letter with its count and no percentage', () => {
    const shown = text(render({ kind: 'letter', letter: 'B', count: 3 }));

    expect(shown).toContain('Estimated grade · 3 released grades B');
    expect(shown).not.toContain('Final grade');
    expect(shown).not.toContain('%');
  });

  it('counts one released grade in the singular', () => {
    expect(text(render({ kind: 'letter', letter: 'C', count: 1 }))).toContain(
      'Estimated grade · 1 released grade C'
    );
  });

  it('shows an emoji estimate where the classroom has no letter scale', () => {
    const shown = text(render({ kind: 'emoji', emoji: 'heart', count: 2 }));

    expect(shown).toContain('Estimated grade · 2 released grades');
    expect(shown).not.toContain('%');
  });

  it('shows no grade line when there is none', () => {
    const shown = text(render(null));

    expect(shown).not.toContain('Final grade');
    expect(shown).not.toContain('Estimated grade');
  });
});
