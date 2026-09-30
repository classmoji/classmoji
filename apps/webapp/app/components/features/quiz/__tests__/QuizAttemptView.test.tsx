/**
 * QuizAttemptView picks the drawer body by the attempt's runtime stamp: the
 * legacy QuizAttemptInterface, with exactly the props it always had, for every
 * attempt not stamped `trigger_chat`; QuizChat for one that is.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const legacyProps: Array<Record<string, unknown>> = [];
const chatProps: Array<Record<string, unknown>> = [];

vi.mock('../QuizAttemptInterface', () => ({
  default: (props: Record<string, unknown>) => {
    legacyProps.push(props);
    return <div data-testid="legacy" />;
  },
}));
vi.mock('../QuizChat', () => ({
  default: (props: Record<string, unknown>) => {
    chatProps.push(props);
    return <div data-testid="chat" />;
  },
}));

const { default: QuizAttemptView } = await import('../QuizAttemptView');
const components = await import('~/components');

const BASE = {
  quiz: { id: 'quiz-1', name: 'Quiz', question_count: 8 },
  messages: [{ id: 'm1', role: 'assistant', content: 'Question 1' }],
  userLogin: 'ada',
  userImage: null,
  readOnly: false,
  showTimestamps: false,
  focusMetrics: null,
  isAdmin: false,
  transcript: null,
  viewerOwnsAttempt: true,
};

beforeEach(() => {
  legacyProps.length = 0;
  chatProps.length = 0;
});

describe('QuizAttemptView', () => {
  it('is what the drawers import as QuizAttemptInterface', () => {
    expect(components.QuizAttemptInterface).toBe(QuizAttemptView);
  });

  it('renders the legacy chat for an ai_agent attempt, with its props unchanged', () => {
    const attempt = { id: 'attempt-1', agent_runtime: 'ai_agent', completed_at: null };
    const html = renderToStaticMarkup(<QuizAttemptView {...BASE} attempt={attempt} />);

    expect(html).toContain('data-testid="legacy"');
    expect(chatProps).toHaveLength(0);
    expect(legacyProps[0]).toMatchObject({ messages: BASE.messages, attempt, userLogin: 'ada' });
    expect(legacyProps[0]).not.toHaveProperty('transcript');
    expect(legacyProps[0]).not.toHaveProperty('viewerOwnsAttempt');
  });

  it('renders the legacy chat for an attempt with no stamp', () => {
    const html = renderToStaticMarkup(
      <QuizAttemptView {...BASE} attempt={{ id: 'attempt-1', completed_at: null }} />
    );
    expect(html).toContain('data-testid="legacy"');
  });

  it('renders QuizChat for a trigger_chat attempt, with its transcript and ownership', () => {
    const attempt = { id: 'attempt-1', agent_runtime: 'trigger_chat', completed_at: null };
    const transcript = [{ id: 'ui-1', role: 'assistant', parts: [] }];
    const html = renderToStaticMarkup(
      <QuizAttemptView
        {...BASE}
        attempt={attempt}
        transcript={transcript as never}
        viewerOwnsAttempt={false}
      />
    );

    expect(html).toContain('data-testid="chat"');
    expect(legacyProps).toHaveLength(0);
    expect(chatProps[0]).toMatchObject({ attempt, transcript, viewerOwnsAttempt: false });
  });
});
