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
  displayOrder,
  drivesSession,
  errorLineFor,
  FIXED_ERROR_COPY,
  NOTICE_COPY,
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
        const arriving = [
          msg('a1', 'assistant', [
            { ...questionPart, state: 'input-available', output: undefined },
          ]),
        ];
        const streaming = renderTranscript(arriving, { busy: true, status: 'streaming' });
        expect(streaming).not.toContain('A reworded question');
        expect(streaming).toContain('ant-skeleton');

        // A turn that ended before its card arrived leaves no empty card.
        const ended = renderTranscript(arriving);
        expect(ended).not.toContain('ant-skeleton');
        expect(ended).not.toContain('data-message-role="assistant"');

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

describe("QuizTranscript — a question's marker above the next card", () => {
  const card = (n: number, id = `call-q${n}`) => ({
    type: 'tool-present_question',
    toolCallId: id,
    state: 'output-available',
    input: { ...CARD, question_number: n, question_text: `Question text ${n}` },
    output: {
      card: { ...CARD, question_number: n, question_text: `Question text ${n}` },
      question_number: n,
      total_questions: 8,
    },
  });
  const divider = (n: number, revised = false) => ({
    type: 'data-question-result',
    id: `question-result-${n}${revised ? '-revised' : ''}`,
    data: {
      question_num: n,
      emoji: 'heart',
      brief_feedback: `Feedback ${n}${revised ? ' revised' : ''}`,
      ...(revised ? { revised: true } : {}),
    },
  });
  const recordCall = (n: number) => ({
    type: 'tool-record_question_result',
    toolCallId: `call-r${n}`,
    state: 'output-available',
    input: { question_num: n, answers: [], brief_feedback: `Feedback ${n}` },
    output: { question_num: n, emoji: 'heart', brief_feedback: `Feedback ${n}` },
  });
  const text = (t: string) => ({ type: 'text', text: t });

  /** Positions of each needle in the markup; every needle must be present. */
  const positions = (html: string, needles: string[]) =>
    needles.map(needle => {
      const at = html.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });
  const expectInOrder = (html: string, needles: string[]) => {
    const at = positions(html, needles);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  };

  it('shows the divider before the next card when both come from one step', () => {
    // The order the parts arrive in: the hidden record call, the new card, then
    // the divider its record call wrote.
    const html = renderTranscript([msg('a1', 'assistant', [recordCall(1), card(2), divider(1)])]);
    expectInOrder(html, ['completed question 1:', 'Question 2 of 8']);
    expect(html.match(/data-testid="quiz-question-result"/g)).toHaveLength(1);
    expect(html.match(/data-testid="quiz-question-card"/g)).toHaveLength(1);
  });

  it('leaves the order alone when the calls came in separate steps', () => {
    const oneMessage = renderTranscript([
      msg('a1', 'assistant', [text('Right.'), divider(1), text('Next up.'), card(2)]),
    ]);
    expectInOrder(oneMessage, ['Right.', 'completed question 1:', 'Next up.', 'Question 2 of 8']);

    // A card in an earlier message is never passed: the reorder stays within a message.
    const twoMessages = renderTranscript([
      msg('a1', 'assistant', [card(2)]),
      msg('u1', 'user', [text('my answer')]),
      msg('a2', 'assistant', [divider(1)]),
    ]);
    expectInOrder(twoMessages, ['Question 2 of 8', 'my answer', 'completed question 1:']);
  });

  it('moves a revised divider above a later card, never above its own question', () => {
    const later = renderTranscript([msg('a1', 'assistant', [card(3), divider(2, true)])]);
    expectInOrder(later, ['question 2 revised:', 'Feedback 2 revised', 'Question 3 of 8']);

    // Strictly later questions only: a divider for the card's own question stays below it.
    const same = renderTranscript([msg('a1', 'assistant', [card(2), divider(2, true)])]);
    expectInOrder(same, ['Question 2 of 8', 'question 2 revised:']);
    const earlier = renderTranscript([msg('a1', 'assistant', [card(2), divider(3)])]);
    expectInOrder(earlier, ['Question 2 of 8', 'completed question 3:']);
  });

  it('keeps text where it was: before the card stays above the divider, after stays below', () => {
    const html = renderTranscript([
      msg('a1', 'assistant', [
        text('That is right.'),
        card(2),
        text('Take your time.'),
        divider(1),
        text('Good luck.'),
      ]),
    ]);
    expectInOrder(html, [
      'That is right.',
      'completed question 1:',
      'Question 2 of 8',
      'Take your time.',
      'Good luck.',
    ]);
  });

  it('keeps dividers moved above the same card in their arrival order', () => {
    expect(
      displayOrder([card(3), divider(1), divider(2, true)] as never).map(e => e.index)
    ).toEqual([1, 2, 0]);
    // Each divider lands above the first later card: 1 above 2, 2 above 3.
    expect(
      displayOrder([card(2), card(3), divider(1), divider(2)] as never).map(e => e.index)
    ).toEqual([2, 0, 3, 1]);
    // A refused card attracts nothing.
    const refused = { ...card(2), state: 'output-error', output: undefined, errorText: 'x' };
    expect(displayOrder([refused, divider(1)] as never).map(e => e.index)).toEqual([0, 1]);
  });

  it('shows the divider above a card that is still arriving, numbered or not', () => {
    for (const input of [{ preamble: 'Next' }, { preamble: 'Next', question_number: 2 }]) {
      const html = renderTranscript(
        [
          msg('a1', 'assistant', [
            recordCall(1),
            {
              type: 'tool-present_question',
              toolCallId: 'call-q2',
              state: 'input-streaming',
              input,
            },
            divider(1),
          ]),
        ],
        { busy: true, status: 'streaming' }
      );
      expectInOrder(html, ['completed question 1:', 'ant-skeleton']);
    }
    // An arriving card numbered for the divider's own question stays above it.
    const own = renderTranscript(
      [
        msg('a1', 'assistant', [
          {
            type: 'tool-present_question',
            toolCallId: 'call-q1',
            state: 'input-available',
            input: { ...CARD, question_number: 1 },
          },
          divider(1),
        ]),
      ],
      { busy: true, status: 'streaming' }
    );
    expectInOrder(own, ['ant-skeleton', 'completed question 1:']);
  });

  it('shows the owner (live) and staff (saved) the same order', () => {
    const attempt = { id: 'attempt-1', completed_at: null, evaluation_json: null };
    const quiz = { id: 'quiz-1', question_count: 8 };
    // Live the record call is in the message; the saved projection drops it.
    const live = [msg('a1', 'assistant', [text('Right.'), recordCall(1), card(2), divider(1)])];
    const saved = [msg('a1', 'assistant', [text('Right.'), card(2), divider(1)])];
    const order = ['Right.', 'completed question 1:', 'Question 2 of 8'];

    const staff = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={saved} viewerOwnsAttempt={false} />
    );
    expectInOrder(staff, order);

    chatState.messages = live;
    const owner = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={live} viewerOwnsAttempt />
    );
    expectInOrder(owner, order);

    // With or without the record call, the transcript is the same markup.
    expect(renderTranscript(live)).toBe(renderTranscript(saved));
  });
});

describe('QuizTranscript — failed tool calls', () => {
  // The AI SDK masks every tool error as this text, and it is saved with the part.
  const MASK = 'An error occurred.';
  const failed = (type: string, state: 'output-error' | 'output-denied' = 'output-error') => ({
    type,
    toolCallId: `call-${type}`,
    state,
    input: { anything: 'the call input' },
    ...(state === 'output-error' ? { errorText: MASK } : {}),
    ...(type === 'dynamic-tool' ? { toolName: 'present_question' } : {}),
  });
  const TOOL_PARTS = [
    'tool-present_question',
    'tool-offer_next_step',
    'tool-submit_quiz_evaluation',
    'tool-record_question_result',
    'tool-explore_codebase',
    'dynamic-tool',
  ];

  for (const type of TOOL_PARTS) {
    for (const state of ['output-error', 'output-denied'] as const) {
      it(`renders nothing for ${type} in ${state}, alone or beside text`, () => {
        for (const busy of [false, true]) {
          const alone = renderTranscript([msg('a1', 'assistant', [failed(type, state)])], {
            busy,
            status: busy ? 'streaming' : 'ready',
          });
          expect(alone).not.toContain(MASK);
          expect(alone).not.toContain('the call input');
          expect(alone).not.toContain('data-message-role="assistant"');
          expect(alone).not.toContain('ant-skeleton');
          expect(alone).not.toContain('quiz-results');

          const beside = renderTranscript([
            msg('a2', 'assistant', [
              { type: 'step-start' },
              failed(type, state),
              { type: 'text', text: 'Here is the next one.' },
            ]),
          ]);
          expect(beside).toContain('Here is the next one.');
          expect(beside).not.toContain(MASK);
          expect(beside).not.toContain('ant-skeleton');
        }
      });
    }
  }

  it('keeps the typing indicator up while an opening reply only lists exploration steps', () => {
    const html = renderTranscript(
      [
        msg('a1', 'assistant', [
          {
            type: 'data-step',
            data: { kind: 'read_file', path: 'src/App.tsx' },
          },
        ]),
      ],
      { busy: true, status: 'streaming' }
    );
    expect(html).toContain('data-testid="quiz-typing"');
    expect(html).toContain('src/App.tsx');
  });

  const attempt = { id: 'attempt-1', completed_at: null, evaluation_json: null };
  const quiz = { id: 'quiz-1', question_count: 8 };
  const withFailures = [
    msg('a1', 'assistant', [failed('tool-present_question'), questionPart]),
    msg(
      'a2',
      'assistant',
      TOOL_PARTS.map(type => failed(type))
    ),
  ];

  it('shows staff the same (saved transcript)', () => {
    const html = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={withFailures} viewerOwnsAttempt={false} />
    );
    expect(html).toContain('Question 1 of 8');
    expect(html).not.toContain(MASK);
    expect(html.match(/data-message-role="assistant"/g)).toHaveLength(1);
  });

  it('shows the owner the same, live', () => {
    chatState.messages = withFailures;
    chatState.status = 'streaming';
    const html = renderToStaticMarkup(
      <QuizChat quiz={quiz} attempt={attempt} transcript={withFailures} viewerOwnsAttempt />
    );
    expect(html).toContain('Question 1 of 8');
    expect(html).not.toContain(MASK);
    expect(html).not.toContain('ant-skeleton');
    // The reply still running has nothing to show yet: the typing indicator stays.
    expect(html).toContain('data-testid="quiz-typing"');
  });
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
    expect(errorLineFor(new Error('TypeError: fetch failed'))).toBe(REPLY_FAILED_LINE);
    expect(errorLineFor(undefined)).toBe(REPLY_FAILED_LINE);
    // The AI SDK's own mask for a stream error is not ours to show.
    expect(errorLineFor(new Error('An error occurred.'))).toBe(REPLY_FAILED_LINE);
  });

  // Every line the task's sanitizer can send (packages/tasks/src/agents/shared/sanitize.ts),
  // byte for byte. Changing one there must change it here.
  const SANITIZER_COPY = [
    "That reply couldn't be finished. Please send your message again.",
    "That reply couldn't be finished. Send your message again.",
    "This quiz can't continue right now.",
    "Quizzes aren't available in this class.",
    'This quiz is already complete.',
    'This attempt can no longer be continued.',
    'This attempt has reached its message limit.',
    "That message couldn't be sent. Please try again.",
    'This quiz has already started.',
    "This quiz isn't available right now. Please try again later.",
  ];

  it("shows every line the task's sanitizer sends, byte for byte", async () => {
    const { QUIZ_AGENT_ERROR_COPY } = await import('@classmoji/utils/quiz-agent');
    expect([...QUIZ_AGENT_ERROR_COPY].sort()).toEqual([...SANITIZER_COPY].sort());
    for (const copy of SANITIZER_COPY) {
      expect(FIXED_ERROR_COPY.has(copy)).toBe(true);
      expect(errorLineFor(new Error(copy))).toBe(copy);
    }
  });

  it('allows no line that mentions timing', () => {
    for (const copy of FIXED_ERROR_COPY) {
      expect(copy).not.toMatch(/too long|took|seconds?\b|minutes?\b|timed? ?out|\bslow/i);
    }
    expect(
      FIXED_ERROR_COPY.has(
        'That reply took too long and was stopped. Please send your message again.'
      )
    ).toBe(false);
  });

  it('says the same thing for a stopped turn as the sanitizer does', () => {
    expect(NOTICE_COPY.turn_stopped).toBe(
      "That reply couldn't be finished. Send your message again."
    );
    expect(NOTICE_COPY.reply_failed).toBe(REPLY_FAILED_LINE);
  });
});
