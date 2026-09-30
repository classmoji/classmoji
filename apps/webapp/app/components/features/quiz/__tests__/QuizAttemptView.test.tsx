/**
 * QuizAttemptView picks the drawer body by the attempt's runtime stamp: the
 * legacy QuizAttemptInterface, with exactly the props it always had, for every
 * attempt not stamped `trigger_chat`; QuizChat for one that is. QuizChat's
 * module is loaded only when a chat attempt renders (lazy), with a loading
 * placeholder until it arrives.
 */

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const legacyProps: Array<Record<string, unknown>> = [];
const chatProps: Array<Record<string, unknown>> = [];
let chatModuleLoads = 0;

/** The markup once every lazy part has loaded (as the server streams it). */
const renderAll = async (element: ReactElement) => {
  const { prelude } = await prerender(element);
  return new Response(prelude as ReadableStream).text();
};

vi.mock('../QuizAttemptInterface', () => ({
  default: (props: Record<string, unknown>) => {
    legacyProps.push(props);
    return <div data-testid="legacy" />;
  },
}));
vi.mock('../QuizChat', () => {
  chatModuleLoads += 1;
  return {
    default: (props: Record<string, unknown>) => {
      chatProps.push(props);
      return <div data-testid="chat" />;
    },
  };
});

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

  it('does not load the chat module for a legacy attempt', () => {
    renderToStaticMarkup(
      <QuizAttemptView
        {...BASE}
        attempt={{ id: 'a', agent_runtime: 'ai_agent', completed_at: null }}
      />
    );
    expect(chatModuleLoads).toBe(0);
  });

  it('shows the loading placeholder until the chat module has loaded', () => {
    const attempt = { id: 'attempt-1', agent_runtime: 'trigger_chat', completed_at: null };
    const html = renderToStaticMarkup(<QuizAttemptView {...BASE} attempt={attempt} />);
    expect(html).toContain('data-testid="quiz-chat-loading"');
    expect(html).not.toContain('data-testid="chat"');
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

  it('renders QuizChat for a trigger_chat attempt, with its transcript and ownership', async () => {
    const attempt = { id: 'attempt-1', agent_runtime: 'trigger_chat', completed_at: null };
    const transcript = [{ id: 'ui-1', role: 'assistant', parts: [] }];
    const html = await renderAll(
      <QuizAttemptView
        {...BASE}
        attempt={attempt}
        transcript={transcript as never}
        viewerOwnsAttempt={false}
      />
    );

    expect(html).toContain('data-testid="chat"');
    expect(html).not.toContain('quiz-chat-loading');
    expect(chatModuleLoads).toBe(1);
    expect(legacyProps).toHaveLength(0);
    expect(chatProps[0]).toMatchObject({ attempt, transcript, viewerOwnsAttempt: false });
  });
});
