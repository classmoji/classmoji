/**
 * QuizGradeEmoji: a quiz grade as the classroom's emoji (E1), never a number;
 * "orig → new" and an "adjusted" chip when staff adjusted it (D6, D8); an
 * "Nh late" chip; an em dash with no grade.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuizGradeEmoji } from '../QuizGradeEmoji';

describe('QuizGradeEmoji', () => {
  it('shows the emoji alone for an untouched grade', () => {
    const html = renderToStaticMarkup(<QuizGradeEmoji emoji="+1" />);
    expect(html).toContain('👍');
    expect(html).not.toContain('adjusted');
    expect(html).not.toContain('late');
  });

  it('shows the original, an arrow, the adjustment and the chip when adjusted', () => {
    const html = renderToStaticMarkup(
      <QuizGradeEmoji emoji="+1" originalEmoji="-1" adjusted lateHours={6} />
    );
    expect(html.indexOf('👎')).toBeLessThan(html.indexOf('→'));
    expect(html.indexOf('→')).toBeLessThan(html.indexOf('👍'));
    expect(html).toContain('data-testid="quiz-grade-adjusted"');
    expect(html).toMatch(/6(<!-- -->)?h late/);
  });

  it('shows the chip without the original when none is given', () => {
    const html = renderToStaticMarkup(<QuizGradeEmoji emoji="+1" adjusted />);
    expect(html).toContain('data-testid="quiz-grade-adjusted"');
    expect(html).not.toContain('data-testid="quiz-grade-original"');
  });

  it('draws a score badge on the numeric scale, never a bare number', () => {
    const html = renderToStaticMarkup(<QuizGradeEmoji emoji="score-90" size="lg" />);
    expect(html).toContain('<img');
    expect(html).not.toMatch(/>\s*90\s*</);
  });

  it('shows an em dash with no grade', () => {
    expect(renderToStaticMarkup(<QuizGradeEmoji emoji={null} />)).toContain('—');
  });
});
