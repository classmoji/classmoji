/**
 * The assignments table's empty state names quizzes only where the classroom
 * shows them (`loadQuizzesVisible`). The prop is optional and absent means
 * hidden, like ModuleCard's and AddContentItemModal's.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AssignmentsTable from '../AssignmentsTable';

const render = (quizzesVisible?: boolean) =>
  renderToStaticMarkup(
    <AssignmentsTable
      assignments={[]}
      classSlug="cs52-26f"
      onEdit={() => {}}
      onDelete={() => {}}
      quizzesVisible={quizzesVisible}
    />
  );

describe('AssignmentsTable empty state', () => {
  it('lists quizzes among the kinds when quizzes are visible', () => {
    expect(render(true)).toContain(
      'An assignment is a repo issue, a quiz, or a form, with a weight and a due date.'
    );
  });

  it('names no quiz when quizzes are hidden', () => {
    const html = render(false);
    expect(html).toContain(
      'An assignment is a repo issue or a form, with a weight and a due date.'
    );
    expect(html).not.toMatch(/quiz/i);
  });

  it('names no quiz when the prop is absent', () => {
    expect(render()).not.toMatch(/quiz/i);
  });
});
