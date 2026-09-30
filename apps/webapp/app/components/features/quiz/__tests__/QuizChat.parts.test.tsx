/**
 * QuizChat, rendered to markup: every part type the quiz agent sends, in the
 * light and dark themes, plus which view (live chat or saved transcript) each
 * viewer gets and the status attribute the test drivers read.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';

let darkMode = false;
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: darkMode }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));

// The live chat's seams: what useChat reports is set per test.
const chatState: { messages: QuizUIMessage[]; status: string; error?: Error } = {
  messages: [],
  status: 'ready',
};
const sendMessageMock = vi.fn();
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({ ...chatState, sendMessage: sendMessageMock }),
}));
const transportOptions: unknown[] = [];
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: (options: unknown) => {
    transportOptions.push(options);
    return {};
  },
  useChatActions: () => ({ sendAction: vi.fn() }),
}));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ sendButtonTestId, disabled }: { sendButtonTestId?: string; disabled?: boolean }) => (
    <div className="tiptap ProseMirror">
      <button data-testid={sendButtonTestId} disabled={disabled}>
        Send
      </button>
    </div>
  ),
}));

const {
  default: QuizChat,
  QuizTranscript,
  drivesSession,
  errorLineFor,
  REPLY_FAILED_LINE,
} = await import('../QuizChat');

const msg = (id: string, role: 'user' | 'assistant', parts: unknown[], metadata?: unknown) =>
  ({ id, role, parts, ...(metadata ? { metadata } : {}) }) as unknown as QuizUIMessage;

const CARD = {
  preamble: 'Let me ask about your header.',
  question_number: 1,
  total_questions: 8,
  question_text: 'Why does the header use flexbox?',
  code_snippet: '.header { display: flex; }',
  code_language: 'css',
};

const questionPart = {
  type: 'tool-present_question',
  toolCallId: 'call-1',
  state: 'output-available',
  input: { ...CARD, question_text: 'A reworded question the server did not accept' },
  output: { card: CARD, question_number: 1, total_questions: 8 },
};

const RECORD = {
  v: 2,
  source: 'model',
  feedback: {
    final_acknowledgment: 'Nice work.',
    evaluation: 'GOOD',
    numeric_score: 3,
    feedback_summary: 'Solid grasp of layout.',
    feedback_strengths: ['Flexbox'],
    feedback_improvements: ['Semantic tags'],
    feedback_recommendation: 'Practice grid.',
    feedback_effort_note: 'Kept at it.',
  },
  partial_credit_percentage: 77.5,
  first_attempt_percentage: 50,
  question_results: [
    {
      question_num: 1,
      attempts: 1,
      tries: 1,
      eventually_correct: true,
      first_attempt_correct: true,
      credit_earned: 100,
      emoji: 'heart',
      brief_feedback: 'Spot on.',
    },
  ],
};

const renderTranscript = (
  messages: QuizUIMessage[],
  extra: Partial<Parameters<typeof QuizTranscript>[0]> = {}
) =>
  renderToStaticMarkup(
    <QuizTranscript
      messages={messages}
      status="ready"
      busy={false}
      isDarkMode={darkMode}
      {...extra}
    />
  );

beforeEach(() => {
  darkMode = false;
  chatState.messages = [];
  chatState.status = 'ready';
  chatState.error = undefined;
  transportOptions.length = 0;
  sendMessageMock.mockReset();
});

describe('QuizTranscript — parts', () => {
  for (const theme of ['light', 'dark'] as const) {
    describe(`in the ${theme} theme`, () => {
      beforeEach(() => {
        darkMode = theme === 'dark';
      });

      it('shows the grading rule above the first question', () => {
        const html = renderTranscript([msg('a1', 'assistant', [questionPart])]);
        const rule = html.indexOf('Your best answer counts, and each hint before it costs 15.');
        expect(rule).toBeGreaterThan(-1);
        expect(rule).toBeLessThan(html.indexOf('Question 1 of 8'));
      });

      it('renders text parts as markdown', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [{ type: 'text', text: 'Good **start**.' }]),
        ]);
        expect(html).toContain('<strong>start</strong>');
      });

      it('renders the question card from the accepted output, never the call input', () => {
        const html = renderTranscript([msg('a1', 'assistant', [questionPart])]);
        expect(html).toContain('Question 1 of 8');
        expect(html).toContain('Why does the header use flexbox?');
        expect(html).toContain('Let me ask about your header.');
        expect(html).not.toContain('A reworded question');
        expect(html).toContain(theme === 'dark' ? '#1e3a5f' : '#e6f4ff');
      });

      it('shows a placeholder while the card is still arriving, and nothing for a refused call', () => {
        const streaming = renderTranscript([
          msg('a1', 'assistant', [
            { ...questionPart, state: 'input-available', output: undefined },
          ]),
        ]);
        expect(streaming).not.toContain('A reworded question');
        expect(streaming).toContain('ant-skeleton');

        const refused = renderTranscript([
          msg('a1', 'assistant', [
            { ...questionPart, state: 'output-error', output: undefined, errorText: 'bad' },
          ]),
        ]);
        expect(refused).not.toContain('Question 1 of 8');
        expect(refused).not.toContain('bad');
      });

      it('renders the per-question marker, and a revision as its own line', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [
            {
              type: 'data-question-result',
              data: { question_num: 2, emoji: 'heart', brief_feedback: 'Got it.' },
            },
            {
              type: 'data-question-result',
              data: { question_num: 1, emoji: 'rocket', brief_feedback: 'Better.', revised: true },
            },
          ]),
        ]);
        expect(html).toContain('completed question 2:');
        expect(html).toContain('Got it.');
        expect(html).toContain('question 1 revised:');
      });

      it('renders the Try again / Next buttons, disabled once a later message exists', () => {
        const buttons = {
          type: 'tool-offer_next_step',
          toolCallId: 'call-2',
          state: 'output-available',
          input: { actions: ['next', 'try_again'] },
          output: { actions: ['next', 'try_again'] },
        };
        const open = renderTranscript([msg('a1', 'assistant', [buttons])], { onButton: vi.fn() });
        expect(open).toContain('data-testid="quiz-try-again"');
        expect(open).toContain('data-testid="quiz-next"');
        expect(open).not.toMatch(/data-testid="quiz-next"[^>]*disabled/);
        // Try again comes first whatever order the tool listed them in.
        expect(open.indexOf('data-testid="quiz-try-again"')).toBeLessThan(
          open.indexOf('data-testid="quiz-next"')
        );

        const answered = renderTranscript(
          [msg('a1', 'assistant', [buttons]), msg('u1', 'user', [{ type: 'text', text: 'next' }])],
          { onButton: vi.fn() }
        );
        expect(answered).toMatch(
          /disabled=""[^>]*data-testid="quiz-try-again"|data-testid="quiz-try-again"[^>]*disabled/
        );

        const readOnly = renderTranscript([msg('a1', 'assistant', [buttons])]);
        expect(readOnly).toMatch(
          /data-testid="quiz-next"[^>]*disabled|disabled=""[^>]*data-testid="quiz-next"/
        );
      });

      it('renders the results panel from the evaluation tool output', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [
            { type: 'text', text: 'Nice work.' },
            {
              type: 'tool-submit_quiz_evaluation',
              toolCallId: 'call-3',
              state: 'output-available',
              input: RECORD.feedback,
              output: RECORD,
            },
          ]),
        ]);
        expect(html).toContain('data-testid="quiz-results"');
        expect(html).toContain('Quiz Evaluation: GOOD');
        expect(html).toContain('Solid grasp of layout.');
        expect(html).toContain('77.5%');
        expect(html).toContain('Spot on.');
      });

      it("renders a server-completed record's scores without feedback sections", () => {
        const serverRecord = { ...RECORD, source: 'server', feedback: undefined };
        const html = renderTranscript([
          msg('a1', 'assistant', [{ type: 'data-evaluation', data: serverRecord }]),
        ]);
        expect(html).toContain('Quiz Results');
        expect(html).toContain('77.5%');
        expect(html).not.toContain('Summary');
        expect(html).not.toContain('Strengths');
      });

      it('prefers the stored record and renders the panel once', () => {
        const stored = { ...RECORD, partial_credit_percentage: 88 };
        const html = renderTranscript(
          [msg('a1', 'assistant', [{ type: 'data-evaluation', data: RECORD }])],
          { evaluationRecord: stored as never, status: 'complete' }
        );
        expect(html).toContain('88%');
        expect(html).not.toContain('77.5%');
        expect(html.match(/data-testid="quiz-results"/g)).toHaveLength(1);
      });

      it('lists the files read, by path only', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [
            { type: 'data-step', data: { kind: 'read_file', path: 'src/index.html' } },
            {
              type: 'data-step',
              data: { kind: 'read_file', path: 'src/missing.css', error: true },
            },
            { type: 'text', text: 'Here is a question.' },
          ]),
        ]);
        expect(html).toContain('Read 2 files');
        expect(html).toContain('src/index.html');
        expect(html).toContain('Couldn&#x27;t read src/missing.css');
      });

      it('renders nothing for reasoning, internal tools, hidden messages or unknown parts', () => {
        const html = renderTranscript([
          msg('h1', 'user', [{ type: 'text', text: 'The student is ready. Begin.' }], {
            hidden: true,
          }),
          msg(
            'u1',
            'user',
            [
              { type: 'text', text: 'my answer' },
              { type: 'text', text: 'CURRENT STATUS: 3 of 8' },
            ],
            { hiddenPartIndexes: [1] }
          ),
          msg('a1', 'assistant', [
            { type: 'reasoning', text: 'private chain of thought' },
            {
              type: 'tool-record_question_result',
              toolCallId: 'c',
              state: 'output-available',
              input: { question_num: 1, answers: [], brief_feedback: 'secret rating' },
              output: { question_num: 1, emoji: 'heart', brief_feedback: 'secret rating' },
            },
            { type: 'data-unknown', data: { leak: 'unknown data' } },
            { type: 'text', text: 'Visible reply.' },
          ]),
        ]);
        expect(html).toContain('my answer');
        expect(html).toContain('Visible reply.');
        for (const hidden of [
          'ready. Begin',
          'CURRENT STATUS',
          'private chain of thought',
          'secret rating',
          'unknown data',
        ]) {
          expect(html).not.toContain(hidden);
        }
      });

      it('shows a notice by its code, with fixed copy', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [{ type: 'data-notice', data: { code: 'reply_failed' } }]),
        ]);
        expect(html).toContain('That reply couldn&#x27;t be finished.');
      });

      it('uses dark variants on its own surfaces', () => {
        const html = renderTranscript([msg('a1', 'assistant', [{ type: 'text', text: 'Hi' }])]);
        expect(html).toContain('dark:bg-gray-800');
        expect(html).toContain('dark:text-amber-200');
      });
    });
  }
});

describe('QuizChat — which view, and its status', () => {
  const attempt = { id: 'attempt-1', completed_at: null, evaluation_json: null };
  const quiz = { id: 'quiz-1', question_count: 8 };

  it('drives the session only for the owner of an open attempt', () => {
    expect(drivesSession({ attempt, readOnly: false, viewerOwnsAttempt: true })).toBe(true);
    expect(drivesSession({ attempt, readOnly: false, viewerOwnsAttempt: false })).toBe(false);
    expect(drivesSession({ attempt, readOnly: true, viewerOwnsAttempt: true })).toBe(false);
    expect(
      drivesSession({
        attempt: { ...attempt, completed_at: '2026-09-30T00:00:00Z' },
        readOnly: false,
        viewerOwnsAttempt: true,
      })
    ).toBe(false);
  });

  it("shows staff a student's open attempt read-only, with no transport and no editor", () => {
    const html = renderToStaticMarkup(
      <QuizChat
        quiz={quiz}
        attempt={attempt}
        transcript={[msg('a1', 'assistant', [questionPart])]}
        viewerOwnsAttempt={false}
        readOnly={false}
      />
    );
    expect(transportOptions).toHaveLength(0);
    expect(html).toContain('data-quiz-status="ready"');
    expect(html).not.toContain('data-testid="quiz-editor"');
    expect(html).toContain('Question 1 of 8');
  });

  it('shows a completed attempt as complete, with its stored results', () => {
    const html = renderToStaticMarkup(
      <QuizChat
        quiz={quiz}
        attempt={{
          ...attempt,
          completed_at: '2026-09-30T00:00:00Z',
          evaluation_json: RECORD as never,
        }}
        transcript={[msg('a1', 'assistant', [questionPart])]}
        viewerOwnsAttempt
        readOnly
      />
    );
    expect(transportOptions).toHaveLength(0);
    expect(html).toContain('data-quiz-status="complete"');
    expect(html).toContain('data-testid="quiz-results"');
  });

  it('gives the owner the live chat with the editor and its test ids', () => {
    chatState.messages = [msg('a1', 'assistant', [questionPart])];
    const html = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={chatState.messages} viewerOwnsAttempt />
    );
    expect(transportOptions).toHaveLength(1);
    expect(transportOptions[0]).toMatchObject({ task: 'quiz-attempt' });
    expect(html).toContain('data-quiz-status="ready"');
    expect(html).toContain('data-testid="quiz-editor"');
    expect(html).toContain('data-testid="quiz-send"');
    expect(html).toContain('tiptap ProseMirror');
  });

  it('reports streaming while a reply runs, and complete once the evaluation is in', () => {
    chatState.status = 'streaming';
    const streaming = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={[]} viewerOwnsAttempt />
    );
    expect(streaming).toContain('data-quiz-status="streaming"');
    expect(streaming).toContain('data-testid="quiz-typing"');

    // The evaluation is in but the closing reply is still streaming.
    chatState.messages = [
      msg('a1', 'assistant', [{ type: 'data-evaluation', data: { ...RECORD, source: 'server' } }]),
    ];
    const closing = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={[]} viewerOwnsAttempt />
    );
    expect(closing).toContain('data-quiz-status="streaming"');

    chatState.status = 'ready';
    const done = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={[]} viewerOwnsAttempt />
    );
    expect(done).toContain('data-quiz-status="complete"');
  });

  it('shows fixed copy for a failed reply, never the raw error', () => {
    chatState.status = 'error';
    chatState.error = new Error('ECONNRESET at api.trigger.dev/realtime');
    chatState.messages = [msg('a1', 'assistant', [questionPart])];
    const html = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={chatState.messages} viewerOwnsAttempt />
    );
    expect(html).toContain('data-testid="quiz-error"');
    expect(html).not.toContain('ECONNRESET');
  });
});

describe('errorLineFor', () => {
  it('passes fixed copy through and replaces anything else', () => {
    expect(errorLineFor(new Error('This quiz is already complete.'))).toBe(
      'This quiz is already complete.'
    );
    // The task's own fixed copy (packages/tasks/src/agents/shared/sanitize.ts).
    for (const copy of [
      'That reply took too long and was stopped. Please send your message again.',
      'This attempt has reached its message limit.',
      "That message couldn't be sent. Please try again.",
      'This quiz has already started.',
      "This quiz isn't available right now. Please try again later.",
      'This attempt can no longer be continued.',
      "Quizzes aren't available in this class.",
    ]) {
      expect(errorLineFor(new Error(copy))).toBe(copy);
    }
    expect(errorLineFor(new Error('TypeError: fetch failed'))).toBe(REPLY_FAILED_LINE);
    expect(errorLineFor(undefined)).toBe(REPLY_FAILED_LINE);
  });
});
