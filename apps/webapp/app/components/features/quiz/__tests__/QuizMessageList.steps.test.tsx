/**
 * How QuizMessageList shows a saved reply's exploration steps, rendered to
 * markup (a read-only transcript from the retired ai-agent runtime).
 *
 * A quiz that read its course material through the classmoji MCP server
 * (content_get / content_search / content_list) saved those calls as steps.
 * When every step is a content step (a standard quiz's always are) the
 * collapsed header says so instead of "Code Analysis (N steps)", which stays
 * for any run that explored code.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import QuizMessageList from '../QuizMessageList';

const CONTENT_GET = {
  action: 'Checking course material',
  toolName: 'mcp__classmoji__content_get',
  title: 'Semantic HTML',
};
const CONTENT_SEARCH = {
  action: 'Searching the course',
  toolName: 'mcp__classmoji__content_search',
};
const READ_FILE = { action: 'Reading src/App.jsx', toolName: 'github_read' };

/** Markup of a saved reply that carries these steps. */
const saved = (steps: object[]) =>
  renderToStaticMarkup(
    <QuizMessageList
      messages={[
        {
          id: 'm1',
          role: 'assistant',
          content: 'Question 1 of 5: What does the `<nav>` element mark up?',
          metadata: { explorationSteps: steps as never },
        },
      ]}
    />
  );

describe('course-material steps on a saved reply', () => {
  it('labels the collapsed list as course material', () => {
    const html = saved([CONTENT_GET, CONTENT_SEARCH]);

    expect(html).toContain('Checked course material (2 steps)');
    expect(html).not.toContain('Code Analysis');
  });

  it('says "1 step", not "1 steps"', () => {
    expect(saved([CONTENT_GET])).toContain('Checked course material (1 step)');
  });

  it('keeps "Code Analysis" for a reply whose steps explored code', () => {
    const html = saved([READ_FILE, CONTENT_GET]);

    expect(html).toContain('Code Analysis (2 steps)');
    expect(html).not.toContain('Checked course material');
  });
});

describe('a saved reply with quick-action markers', () => {
  it('shows its text without the markers and offers no buttons to press', () => {
    const html = renderToStaticMarkup(
      <QuizMessageList
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: 'Not quite.\n\n[BUTTON:TRY_AGAIN] [BUTTON:NEXT]',
          },
        ]}
      />
    );

    expect(html).toContain('Not quite.');
    expect(html).not.toContain('[BUTTON:');
    expect(html).not.toContain('Try Again');
    expect(html).not.toContain('Next →');
    expect(html).not.toContain('<button');
  });
});
