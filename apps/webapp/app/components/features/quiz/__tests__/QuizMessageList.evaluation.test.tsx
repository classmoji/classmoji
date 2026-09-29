/**
 * The evaluation card in QuizMessageList, rendered to markup. Its data is
 * what QuizAttemptInterface passes (a completed attempt's stored scores); an
 * evaluation message alone shows its text in the transcript and no card.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import QuizMessageList from '../QuizMessageList';

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
    expect(html).toContain('66.7%');
  });
});
