/**
 * The evaluation card in QuizMessageList, rendered to markup. Its data is
 * what QuizAttemptInterface passes (a completed attempt's stored scores); an
 * evaluation message alone shows its text in the transcript and no card.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import QuizMessageList from '../QuizMessageList';
import { QuizResultProvider } from '../QuizResultContext';

const EVALUATION_MESSAGE = {
  id: 'm3',
  role: 'assistant',
  content:
    'Great work!\n\n[QUIZ_EVALUATION]\n```json\n' +
    '{"quiz_complete": true, "evaluation": "GOOD", "numeric_score": 3, "partial_credit_percentage": 100}\n```',
};

describe('QuizMessageList — the evaluation card', () => {
  it('shows no card from an evaluation message alone, read-only included', () => {
    const html = renderToStaticMarkup(
      <QuizMessageList messages={[EVALUATION_MESSAGE]} readOnly isQuizComplete />
    );

    expect(html).toContain('Great work!');
    expect(html).not.toContain('Quiz Complete!');
  });

  it('shows the card with the data it is given', () => {
    const html = renderToStaticMarkup(
      <QuizMessageList
        messages={[EVALUATION_MESSAGE]}
        readOnly
        isQuizComplete
        evaluationData={{
          evaluation: 'GOOD',
          numeric_score: 3,
          partial_credit_percentage: 66.7,
          question_results: [],
        }}
      />
    );

    expect(html).toContain('Quiz Complete!');
    expect(html).toContain('Quiz Evaluation: GOOD');
    // No grade number (E1, E3): the progress ring is gone.
    expect(html).not.toContain('66.7');
  });

  it("shows the drawer's grade as a large emoji, the band following the adjustment (D9)", () => {
    const html = renderToStaticMarkup(
      <QuizResultProvider
        value={{
          grade: {
            emoji: 'rocket',
            originalEmoji: 'eyes',
            adjusted: true,
            band: { evaluation: 'EXCELLENT', numeric_score: 4 },
            lateHours: 6,
            countedEmoji: '+1',
          },
          headerExtra: <span data-testid="header-extra" />,
          beforeResults: <div data-testid="before-results" />,
        }}
      >
        <QuizMessageList
          messages={[EVALUATION_MESSAGE]}
          readOnly
          isQuizComplete
          evaluationData={{
            evaluation: 'GOOD',
            numeric_score: 3,
            partial_credit_percentage: 66.7,
            question_results: [
              { question_num: 1, attempts: 1, credit_earned: 100, emoji: 'rocket' },
              { question_num: 2, attempts: 2, credit_earned: 50, emoji: null },
            ],
          }}
        />
      </QuizResultProvider>
    );

    expect(html).toContain('Quiz Evaluation: EXCELLENT');
    expect(html).not.toContain('Quiz Evaluation: GOOD');
    expect(html).toContain('data-testid="quiz-grade-hero-emoji"');
    expect(html).toContain('adjusted from');
    expect(html).toContain('6h late');
    expect(html).toContain('data-testid="header-extra"');
    expect(html.indexOf('data-testid="before-results"')).toBeLessThan(
      html.indexOf('Quiz Complete!')
    );
    expect(html).not.toContain('66.7');
    // The per-question emoji is the stored one (🚀), never recomputed.
    expect(html.match(/🚀/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("shows the drawer's blocks on a completed attempt with no evaluation record", () => {
    const slots = { grade: null, beforeResults: <div data-testid="staff-adjust-panel" /> };
    const html = renderToStaticMarkup(
      <QuizResultProvider value={slots}>
        <QuizMessageList messages={[{ id: 'm1', role: 'assistant', content: 'Hi' }]} readOnly />
      </QuizResultProvider>
    );
    expect(html).not.toContain('Quiz Complete!');
    expect(html).toContain('data-testid="quiz-result-slots-fallback"');
    expect(html.match(/data-testid="staff-adjust-panel"/g)).toHaveLength(1);

    // With the card, the blocks are inside it and not repeated.
    const card = renderToStaticMarkup(
      <QuizResultProvider value={slots}>
        <QuizMessageList
          messages={[EVALUATION_MESSAGE]}
          readOnly
          isQuizComplete
          evaluationData={{ evaluation: 'GOOD', numeric_score: 3, question_results: [] }}
        />
      </QuizResultProvider>
    );
    expect(card).toContain('Quiz Complete!');
    expect(card).not.toContain('quiz-result-slots-fallback');
    expect(card.match(/data-testid="staff-adjust-panel"/g)).toHaveLength(1);

    // A running attempt shows none; no slots (a drawer without them) render nothing.
    const running = renderToStaticMarkup(
      <QuizResultProvider value={slots}>
        <QuizMessageList messages={[{ id: 'm1', role: 'assistant', content: 'Hi' }]} />
      </QuizResultProvider>
    );
    expect(running).not.toContain('staff-adjust-panel');
    expect(renderToStaticMarkup(<QuizMessageList messages={[]} readOnly />)).not.toContain(
      'quiz-result-slots-fallback'
    );
  });
});
