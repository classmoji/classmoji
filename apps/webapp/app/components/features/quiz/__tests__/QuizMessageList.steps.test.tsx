/**
 * How QuizMessageList shows exploration steps, rendered to markup.
 *
 * A quiz that reads its course material through the classmoji MCP server
 * (content_get / content_search / content_list) streams those calls as steps.
 * They get a book icon, and a content_get step names the document it opened
 * ("Checking course material · Semantic HTML"). When every step is a content
 * step (a standard quiz's always are) the headers say so instead of the
 * code-analysis ones ("Exploring code...", "Analyzing your code...",
 * "Code Analysis (N steps)"), which stay for any run that explored code.
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

/** Markup while the quiz is working, with these steps streaming in. */
const live = (steps: object[]) =>
  renderToStaticMarkup(<QuizMessageList messages={[]} loading explorationSteps={steps as never} />);

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

describe('course-material steps while the quiz works', () => {
  it('uses neutral headers, a book icon and the document title', () => {
    const html = live([CONTENT_GET, CONTENT_SEARCH]);

    expect(html).toContain('Looking things up…');
    expect(html).toContain('Checking course material…');
    expect(html).toContain('Checking course material · Semantic HTML');
    expect(html).toContain('Searching the course');
    expect(html).toContain('aria-label="book"');
    expect(html).not.toContain('Exploring code');
    expect(html).not.toContain('Analyzing your code');
  });

  it('keeps the code headers when the run also explored code', () => {
    const html = live([READ_FILE, CONTENT_GET]);

    expect(html).toContain('Exploring code...');
    expect(html).toContain('Analyzing your code...');
    expect(html).toContain('Checking course material · Semantic HTML');
    expect(html).toContain('aria-label="book"');
  });

  it('shows a step without a title as its label alone', () => {
    const html = live([{ ...CONTENT_GET, title: undefined }]);

    expect(html).toContain('Checking course material<');
    expect(html).not.toContain(' · ');
  });
});

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
