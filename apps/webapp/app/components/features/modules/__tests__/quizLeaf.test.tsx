// @vitest-environment jsdom
/**
 * A quiz as a module leaf (the student Modules page, and the staff preview of
 * it). Everything the leaf shows is read off the quiz's assignment: whether it
 * is published, its close date and its due date. The leaf opens that quiz on
 * the quiz list.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/components/features/pages', () => ({ PageLink: () => null }));

const { buildResourceLeaves } = await import('../ReadOnlyModulesTree');

const CTX = {
  classSlug: 'cs52',
  slidesUrl: 'https://slides.example',
  pagesUrl: 'https://pages.example',
  quizzesHref: '/student/cs52/quizzes',
};

const HOUR = 60 * 60 * 1000;

const leafFor = (
  quiz: Partial<{
    published: boolean;
    closesAt: Date | null;
    due: Date | null;
  }>,
  isStaff = false
) =>
  buildResourceLeaves({ quizzes: [{ id: 'quiz-1', name: 'Recursion', ...quiz }] }, 0, 'k', {
    ...CTX,
    isStaff,
  })[0];

let container: HTMLDivElement | null = null;
const textOf = (node: unknown): string => {
  container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<>{node as never}</>));
  const text = container.textContent ?? '';
  act(() => root.unmount());
  return text;
};

afterEach(() => {
  container = null;
});

describe('quiz module leaf', () => {
  it('opens the quiz itself on the quiz list', () => {
    expect(leafFor({}).href).toBe('/student/cs52/quizzes?quiz=quiz-1');
  });

  it("shows the assignment's due date, and none without one", () => {
    const due = new Date('2026-10-12T23:59:00Z');
    expect(leafFor({ due }).dueText).toBe(due.toLocaleDateString());
    expect(leafFor({ due: null }).dueText).toBeUndefined();
  });

  it('marks an unpublished quiz as a draft in the staff preview only', () => {
    expect(textOf(leafFor({ published: false }, true).statusNode)).toBe('Draft');
    expect(textOf(leafFor({ published: false }, false).statusNode)).toBe('');
    expect(textOf(leafFor({ published: true }, true).statusNode)).toBe('');
  });

  it('reads Closed once the close date has passed, and not before', () => {
    const now = Date.now();
    expect(textOf(leafFor({ closesAt: new Date(now - HOUR) }).statusNode)).toBe('Closed');
    expect(textOf(leafFor({ closesAt: new Date(now + HOUR) }).statusNode)).toBe('');
    expect(textOf(leafFor({ closesAt: null }).statusNode)).toBe('');
  });
});
