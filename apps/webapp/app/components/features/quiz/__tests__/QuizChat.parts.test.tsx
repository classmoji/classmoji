/**
 * QuizChat, rendered to markup: every part type the quiz agent sends, in the
 * light and dark themes, plus which view (live chat or saved transcript) each
 * viewer gets and the status attribute the test drivers read.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectMessage,
  quizStaffVisibility,
  quizVisibility,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';

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
  activityLine,
  displayOrder,
  drivesSession,
  errorLineFor,
  FIXED_ERROR_COPY,
  isPermanentSessionRefusal,
  NOTICE_COPY,
  QuizChatSessionError,
  REPLY_FAILED_LINE,
  requestSession,
  THINKING_LINE,
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

/** An earlier turn, so a reply under test is not the opening one (whose first text is the welcome's own bubble). */
const EARLIER = [
  msg('a0', 'assistant', [{ type: 'text', text: 'Welcome.' }]),
  msg('u0', 'user', [{ type: 'text', text: 'my answer' }]),
];

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

      it('shows no grading rule above the questions', () => {
        const html = renderTranscript([msg('a1', 'assistant', [questionPart])]);
        expect(html).toContain('Question 1 of 8');
        expect(html).not.toContain('quiz-grading-rule');
        expect(html).not.toContain('each hint before it costs');
      });

      it('renders text parts as markdown', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [{ type: 'text', text: 'Good **start**.' }]),
        ]);
        expect(html).toContain('<strong class="font-semibold">start</strong>');
      });

      it('styles headings, quotes and emphasis as the legacy chat did', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [
            {
              type: 'text',
              text: '# Big\n\n## Middle\n\n### Small\n\n> Quoted\n\n*leaning* and **bold**',
            },
          ]),
        ]);
        expect(html).toContain('<h1 class="mt-3 mb-2 text-[1.5em] font-semibold">Big</h1>');
        expect(html).toContain('<h2 class="mt-2.5 mb-1.5 text-[1.3em] font-semibold">Middle</h2>');
        expect(html).toContain('<h3 class="mt-2 mb-1 text-[1.1em] font-semibold">Small</h3>');
        expect(html).toMatch(/<blockquote class="[^"]*border-l-\[3px\][^"]*">/);
        expect(html).toContain('dark:border-[#4b5563]');
        expect(html).toContain('dark:text-[#9ca3af]');
        expect(html).toContain('<em class="italic">leaning</em>');
        expect(html).toContain('<strong class="font-semibold">bold</strong>');
      });

      it('renders the question card from the accepted output, never the call input', () => {
        const html = renderTranscript([msg('a1', 'assistant', [questionPart])]);
        expect(html).toContain('Question 1 of 8');
        expect(html).toContain('Why does the header use flexbox?');
        expect(html).toContain('Let me ask about your header.');
        expect(html).not.toContain('A reworded question');
        expect(html).toContain(theme === 'dark' ? '#1e3a5f' : '#e6f4ff');
      });

      it('labels quoted code with its file and lines, above the code', () => {
        const quotedCard = {
          ...CARD,
          code_snippet: '.features {\n  display: grid;\n...\n}',
          source: { path: 'css/style.css', lines: '11-12, 15', changed: false },
        };
        const html = renderTranscript([
          msg('a1', 'assistant', [
            {
              ...questionPart,
              output: { card: quotedCard, question_number: 1, total_questions: 8 },
            },
          ]),
        ]);
        const label = html.indexOf('data-testid="quiz-code-source"');
        expect(label).toBeGreaterThan(-1);
        expect(label).toBeLessThan(html.indexOf('<pre'));
        expect(html).toContain('css/style.css');
        expect(html).toContain('lines 11–12, 15');
        expect(html).toContain(theme === 'dark' ? 'color:#9ca3af' : 'color:#4b5563');
      });

      it('names the one line of a one-line quote, and marks nothing for an edited quote', () => {
        const editedCard = {
          ...CARD,
          source: { path: 'css/style.css', lines: '13', changed: true },
        };
        const html = renderTranscript([
          msg('a1', 'assistant', [
            {
              ...questionPart,
              output: { card: editedCard, question_number: 1, total_questions: 8 },
            },
          ]),
        ]);
        expect(html).toContain('data-testid="quiz-code-source"');
        expect(html).toContain('line 13');
        expect(html).not.toContain('lines 13');
        expect(html).not.toContain('>edited<');
        expect(html).not.toContain('quiz-code-edited');
        expect(html).toContain(theme === 'dark' ? 'color:#9ca3af' : 'color:#4b5563');
      });

      it('shows a card without a source as before, with no label', () => {
        const html = renderTranscript([msg('a1', 'assistant', [questionPart])]);
        expect(html).toContain('<pre');
        expect(html).toContain('.header</span>');
        expect(html).not.toContain('quiz-code-source');
      });

      it('shows a placeholder while the card is still arriving, and nothing for a refused call', () => {
        const card = { ...questionPart, state: 'input-available', output: undefined };
        const arriving = [
          ...EARLIER,
          msg('a1', 'assistant', [{ type: 'text', text: 'One more.' }, card]),
        ];
        const streaming = renderTranscript(arriving, { busy: true, status: 'streaming' });
        expect(streaming).not.toContain('A reworded question');
        expect(streaming).toContain('ant-skeleton');

        // Alone it opens no bubble: no empty bubble, the activity line instead.
        const alone = renderTranscript([msg('a1', 'assistant', [card])], {
          busy: true,
          status: 'streaming',
        });
        expect(alone).not.toContain('ant-skeleton');
        expect(alone).not.toContain('quiz-assistant-bubble');
        expect(alone).not.toContain('data-message-role="assistant"');
        expect(alone).toContain('data-testid="quiz-typing"');

        // A turn that ended before its card arrived leaves no empty card.
        const ended = renderTranscript(arriving);
        expect(ended).not.toContain('ant-skeleton');
        expect(ended).toContain('One more.');

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

      it('renders the Try again / Next buttons, disabled once one is clicked', () => {
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

      it("renders a server-completed record's band and scores without feedback sections", () => {
        const serverRecord = {
          ...RECORD,
          source: 'server',
          feedback: undefined,
          evaluation: 'NEEDS WORK',
          numeric_score: 2,
        };
        const html = renderTranscript([
          msg('a1', 'assistant', [{ type: 'data-evaluation', data: serverRecord }]),
        ]);
        expect(html).toContain('Quiz Evaluation: NEEDS WORK');
        expect(html).not.toContain('Quiz Results');
        expect(html).toContain('77.5%');
        expect(html).not.toContain('Summary');
        expect(html).not.toContain('Strengths');
      });

      it('titles a record with no band anywhere (stored before it was added) Quiz Results', () => {
        const older = { ...RECORD, source: 'server', feedback: undefined };
        const html = renderTranscript([
          msg('a1', 'assistant', [{ type: 'data-evaluation', data: older }]),
        ]);
        expect(html).toContain('Quiz Results');
        expect(html).not.toContain('Quiz Evaluation');
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
        expect(html).toContain('Code Analysis (2 steps)');
        expect(html).toContain('aria-label="rocket"');
        expect(html).toContain('src/index.html');
        expect(html).toContain('Couldn&#x27;t read src/missing.css');
        // Collapsed once the reply is done, the paths still in the page.
        expect(html).not.toContain('ant-collapse-item-active');
        expect(html).toContain(theme === 'dark' ? '#111827' : '#fafafa');
      });

      it('says one step for one file', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [
            { type: 'data-step', data: { kind: 'read_file', path: 'src/index.html' } },
            { type: 'text', text: 'Here is a question.' },
          ]),
        ]);
        expect(html).toContain('Code Analysis (1 step)');
      });

      it('shows the lead-in line above the buttons, and nothing without one', () => {
        const buttons = (output: object) => ({
          type: 'tool-offer_next_step',
          toolCallId: 'call-2',
          state: 'output-available',
          input: { actions: ['next'] },
          output,
        });
        const withLine = renderTranscript([
          msg('a1', 'assistant', [
            { type: 'text', text: 'Right.' },
            buttons({ actions: ['next'], lead_in: 'Ready for the next question?' }),
          ]),
        ]);
        const line = withLine.indexOf('Ready for the next question?');
        expect(line).toBeGreaterThan(-1);
        expect(line).toBeLessThan(withLine.indexOf('data-testid="quiz-next"'));
        expect(withLine).toContain('data-testid="quiz-next-step-lead-in"');

        for (const output of [{ actions: ['next'] }, { actions: ['next'], lead_in: '  ' }]) {
          const without = renderTranscript([msg('a1', 'assistant', [buttons(output)])]);
          expect(without).toContain('data-testid="quiz-next"');
          expect(without).not.toContain('quiz-next-step-lead-in');
        }
      });

      it('shows the closing line above the results, once, unless the reply closed in its own words', () => {
        const evaluation = {
          type: 'tool-submit_quiz_evaluation',
          toolCallId: 'call-3',
          state: 'output-available',
          input: RECORD.feedback,
          output: {
            ...RECORD,
            feedback: { ...RECORD.feedback, final_acknowledgment: 'All done!' },
          },
        };
        const html = renderTranscript([
          msg('a1', 'assistant', [
            { type: 'text', text: 'That last one was right.' },
            {
              type: 'data-question-result',
              data: { question_num: 8, emoji: 'heart', brief_feedback: 'Spot on.' },
            },
            evaluation,
          ]),
        ]);
        const closing = html.indexOf('data-testid="quiz-closing-acknowledgment"');
        expect(closing).toBeGreaterThan(html.indexOf('completed question 8:'));
        expect(closing).toBeLessThan(html.indexOf('data-testid="quiz-results"'));
        expect(html.match(/All done!/g)).toHaveLength(1);
        expect(html).toContain(theme === 'dark' ? 'dark:bg-gray-800' : 'bg-white');

        // Text of its own after the last marker comes first: no second closing line.
        const ownWords = renderTranscript([
          msg('a1', 'assistant', [{ type: 'text', text: 'Well played.' }, evaluation]),
        ]);
        expect(ownWords).toContain('Well played.');
        expect(ownWords).not.toContain('All done!');

        // A server-completed record has no closing line.
        const server = renderTranscript([
          msg('a1', 'assistant', [
            { type: 'data-evaluation', data: { ...RECORD, source: 'server', feedback: undefined } },
          ]),
        ]);
        expect(server).not.toContain('quiz-closing-acknowledgment');
      });

      it('shows the stored closing line on a completed attempt with no evaluation part', () => {
        const html = renderTranscript([msg('a1', 'assistant', [questionPart])], {
          evaluationRecord: RECORD as never,
          status: 'complete',
        });
        const closing = html.indexOf('data-testid="quiz-closing-acknowledgment"');
        expect(closing).toBeGreaterThan(html.indexOf('Question 1 of 8'));
        expect(closing).toBeLessThan(html.indexOf('data-testid="quiz-results"'));
        expect(html).toContain('Nice work.');
      });

      it('counts each question in attempts, as the legacy results did', () => {
        const record = {
          ...RECORD,
          question_results: [
            { ...RECORD.question_results[0], attempts: 1, tries: 1 },
            { ...RECORD.question_results[0], question_num: 2, attempts: 3, tries: 3 },
          ],
        };
        const html = renderTranscript([], {
          evaluationRecord: record as never,
          status: 'complete',
        });
        expect(html).toContain('1 attempt<');
        expect(html).toContain('3 attempts<');
        expect(html).not.toMatch(/\btr(y|ies)\b/);
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
      });
    });
  }
});

describe('QuizTranscript — the feedback offer_next_step carries', () => {
  const offer = (state: string, input?: object, output?: object) => ({
    type: 'tool-offer_next_step',
    toolCallId: 'call-offer',
    state,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    ...(state === 'output-error' ? { errorText: 'An error occurred.' } : {}),
  });
  const FEEDBACK = '**Close**: the loop runs one step too far.';
  const ANSWER = 'SENTINEL: the loop should stop at items.length - 1.';
  const LEAD_IN = 'Want another go?';
  const BOTH = ['try_again', 'next'];
  const expectInOrder = (html: string, needles: string[]) => {
    const at = needles.map(needle => html.indexOf(needle));
    expect(at.every(i => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  };
  const busyView = { busy: true, status: 'streaming' as const };

  for (const theme of ['light', 'dark'] as const) {
    describe(`in the ${theme} theme`, () => {
      beforeEach(() => {
        darkMode = theme === 'dark';
      });

      it('shows it as the message in the bubble, above the lead-in and the buttons', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [
            offer(
              'output-available',
              { feedback: FEEDBACK, actions: BOTH },
              { actions: BOTH, lead_in: LEAD_IN }
            ),
          ]),
        ]);
        expect(html.match(/data-testid="quiz-assistant-bubble"/g)).toHaveLength(1);
        expectInOrder(html, [
          'data-testid="quiz-assistant-bubble"',
          '<strong class="font-semibold">Close</strong>',
          'the loop runs one step too far.',
          'data-testid="quiz-next-step-lead-in"',
          LEAD_IN,
          'data-testid="quiz-next-step"',
          'data-testid="quiz-try-again"',
          'data-testid="quiz-next"',
        ]);
        expect(html).not.toContain('**Close**');
      });

      it('renders the feedback exactly as a text part with the same words', () => {
        const asText = renderTranscript([
          msg('a1', 'assistant', [{ type: 'text', text: FEEDBACK }]),
        ]);
        const asOffer = renderTranscript([
          msg('a1', 'assistant', [offer('input-available', { feedback: FEEDBACK, actions: BOTH })]),
        ]);
        expect(asOffer).toBe(asText);
      });

      it('shows the feedback while it streams, with no buttons, above the activity line', () => {
        for (const part of [
          offer('input-streaming', { feedback: 'Close: the loop' }),
          offer('input-available', { feedback: 'Close: the loop', actions: ['next'] }),
        ]) {
          const html = renderTranscript([msg('a1', 'assistant', [part])], busyView);
          expect(html.match(/data-testid="quiz-assistant-bubble"/g)).toHaveLength(1);
          expect(html).not.toContain('data-testid="quiz-next-step"');
          expect(html).not.toContain('quiz-next-step-lead-in');
          expectInOrder(html, ['Close: the loop', 'data-testid="quiz-typing"']);
        }
        // No feedback yet: nothing to show, the activity line alone.
        for (const input of [undefined, {}, { feedback: '  ' }, { actions: ['next'] }]) {
          const html = renderTranscript(
            [msg('a1', 'assistant', [offer('input-streaming', input)])],
            busyView
          );
          expect(html).not.toContain('data-testid="quiz-assistant-bubble"');
          expect(html).toContain('data-testid="quiz-typing"');
        }
      });

      it('renders nothing for a refused offer, whatever feedback it carried', () => {
        for (const state of ['output-error', 'output-denied']) {
          for (const busy of [false, true]) {
            const html = renderTranscript(
              [
                msg('a1', 'assistant', [
                  offer(state, { feedback: 'Refused feedback.', actions: ['next'] }),
                ]),
              ],
              { busy, status: busy ? 'streaming' : 'ready' }
            );
            expect(html).not.toContain('Refused feedback.');
            expect(html).not.toContain('An error occurred.');
            expect(html).not.toContain('data-testid="quiz-next-step"');
            expect(html).not.toContain('data-message-role="assistant"');
          }
        }
      });

      it('shows staff the expected answer as a muted line under the feedback, above the buttons', () => {
        const html = renderTranscript([
          msg('a1', 'assistant', [
            offer(
              'output-available',
              { expected_answer: ANSWER, feedback: FEEDBACK, actions: BOTH },
              { actions: BOTH, lead_in: LEAD_IN }
            ),
          ]),
        ]);
        expect(html.match(/data-testid="quiz-assistant-bubble"/g)).toHaveLength(1);
        expectInOrder(html, [
          '<strong class="font-semibold">Close</strong>',
          'data-testid="quiz-expected-answer"',
          'Expected:',
          ANSWER,
          LEAD_IN,
          'data-testid="quiz-try-again"',
        ]);
        const line = html.slice(html.lastIndexOf('<p', html.indexOf('quiz-expected-answer')));
        expect(line).toMatch(/^<p class="[^"]*text-xs text-gray-500 dark:text-gray-400[^"]*"/);
      });

      it("shows no expected answer in a student's copy of the same reply, only in staff's", () => {
        const stored = msg('a1', 'assistant', [
          offer(
            'output-available',
            { expected_answer: ANSWER, feedback: FEEDBACK, actions: BOTH },
            { actions: BOTH, lead_in: LEAD_IN }
          ),
        ]);
        const student = renderTranscript([projectMessage(stored, quizVisibility)!]);
        expect(student).toContain('the loop runs one step too far.');
        expect(student).toContain('data-testid="quiz-try-again"');
        expect(student).not.toContain('quiz-expected-answer');
        expect(student).not.toContain('SENTINEL');
        expect(student).not.toContain('Expected:');

        const staff = renderTranscript([projectMessage(stored, quizStaffVisibility)!]);
        expect(staff).toContain('data-testid="quiz-expected-answer"');
        expect(staff).toContain(ANSWER);
      });

      it('shows no expected-answer line when there is none, or it is blank', () => {
        for (const expected_answer of [undefined, '', '  \n']) {
          const html = renderTranscript([
            msg('a1', 'assistant', [
              offer(
                'output-available',
                { expected_answer, feedback: FEEDBACK, actions: BOTH },
                { actions: BOTH, lead_in: LEAD_IN }
              ),
            ]),
          ]);
          expect(html).toContain('the loop runs one step too far.');
          expect(html).not.toContain('quiz-expected-answer');
        }
      });

      it('shows text the model also wrote first, then the feedback, the lead-in and the buttons', () => {
        // After an earlier turn: the opening reply's first text is the welcome's own bubble.
        const html = renderTranscript([
          ...EARLIER,
          msg('a1', 'assistant', [
            { type: 'text', text: 'Thanks for explaining.' },
            offer(
              'output-available',
              { feedback: FEEDBACK, actions: ['next'] },
              { actions: ['next'], lead_in: LEAD_IN }
            ),
          ]),
        ]);
        const reply = html.slice(html.indexOf('my answer'));
        expect(reply.match(/data-testid="quiz-assistant-bubble"/g)).toHaveLength(1);
        expectInOrder(reply, [
          'data-testid="quiz-assistant-bubble"',
          'Thanks for explaining.',
          '<strong class="font-semibold">Close</strong>',
          LEAD_IN,
          'data-testid="quiz-next"',
        ]);
      });
    });
  }

  it('keeps the activity line up until the buttons arrive, not the feedback', () => {
    const reply = (parts: unknown[]) => msg('a1', 'assistant', parts);
    const streamingOffer = offer('input-streaming', { feedback: 'Close: the loop' });
    expect(activityLine(reply([streamingOffer]))).toBe(THINKING_LINE);
    expect(
      activityLine(reply([offer('input-available', { feedback: FEEDBACK, actions: ['next'] })]))
    ).toBe(THINKING_LINE);
    expect(activityLine(reply([{ type: 'text', text: 'Thanks.' }, streamingOffer]))).toBe(
      THINKING_LINE
    );
    expect(
      activityLine(
        reply([
          offer(
            'output-available',
            { feedback: FEEDBACK, actions: ['next'] },
            { actions: ['next'], lead_in: LEAD_IN }
          ),
        ])
      )
    ).toBeNull();
    // An old offer (no feedback) ends it the same way.
    expect(
      activityLine(reply([offer('output-available', { actions: ['next'] }, { actions: ['next'] })]))
    ).toBeNull();
  });
});

describe('QuizTranscript — a quoted card as the viewer receives it', () => {
  const quote = {
    path: 'css/style.css',
    ranges: [[11, 15]],
    anchor: '.features {',
    edit: { line: 13, replace: '  grid-template-columns: 1fr;' },
  };
  const { code_snippet: _typed, ...cardFields } = CARD;
  const quotedCard = {
    ...cardFields,
    code_snippet: '.features {\n  display: grid;\n  grid-template-columns: 1fr;\n...\n}',
    source: { path: 'css/style.css', lines: '11-15', changed: true },
  };

  it('renders the card from the output once the projection has cut the quote from the input', () => {
    const stored = msg('a1', 'assistant', [
      {
        ...questionPart,
        input: { ...cardFields, code_quote: quote },
        output: { card: quotedCard, question_number: 1, total_questions: 8 },
      },
    ]);
    const projected = projectMessage(stored, quizVisibility)!;
    expect(JSON.stringify(projected)).not.toContain('code_quote');

    const html = renderTranscript([projected]);
    expect(html).toContain('Why does the header use flexbox?');
    expect(html).toContain('data-testid="quiz-code-source"');
    expect(html).toContain('lines 11–15');
    expect(html).toContain('grid-template-columns');
  });

  it('shows the placeholder for a card arriving with no input yet, beside text', () => {
    const arriving = msg('a1', 'assistant', [
      { type: 'text', text: 'Next up.' },
      { type: 'tool-present_question', toolCallId: 'call-1', state: 'input-streaming' },
    ]);
    const html = renderTranscript([...EARLIER, arriving], { busy: true, status: 'streaming' });
    expect(html).toContain('ant-skeleton');
  });
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

  it('keeps text before the card above the divider, and shows no text after the card', () => {
    const html = renderTranscript([
      msg('a1', 'assistant', [
        text('That is right.'),
        card(2),
        text('Take your time.'),
        divider(1),
        text('Good luck.'),
      ]),
    ]);
    expectInOrder(html, ['That is right.', 'completed question 1:', 'Question 2 of 8']);
    // As in the legacy chat: what follows a card only restates it.
    expect(html).not.toContain('Take your time.');
    expect(html).not.toContain('Good luck.');
  });

  it('holds the next card back while its question marker is still being recorded', () => {
    const pending = (n: number | undefined, state = 'input-available') => ({
      ...recordCall(n ?? 1),
      state,
      input: n === undefined ? {} : { question_num: n, answers: [] },
      output: undefined,
    });
    const arriving = {
      type: 'tool-present_question',
      toolCallId: 'call-q2',
      state: 'input-streaming',
      input: { preamble: 'Next', question_number: 2 },
    };
    for (const [record, next] of [
      [pending(1), arriving],
      [pending(1, 'input-streaming'), arriving],
      [pending(undefined, 'input-streaming'), { ...arriving, input: { preamble: 'Next' } }],
      [pending(1), card(2)],
    ] as const) {
      const html = renderTranscript([msg('a1', 'assistant', [text('Right.'), record, next])], {
        busy: true,
        status: 'streaming',
      });
      expect(html).toContain('Right.');
      expect(html).not.toContain('ant-skeleton');
      expect(html).not.toContain('Question 2 of 8');
      // Still waiting for the reply: the activity line stays up.
      expect(html).toContain('data-testid="quiz-typing"');
    }

    // The record call done, its marker in: the card follows it, once it is in.
    const done = renderTranscript(
      [msg('a1', 'assistant', [text('Right.'), recordCall(1), arriving, divider(1)])],
      { busy: true, status: 'streaming' }
    );
    expectInOrder(done, ['Right.', 'completed question 1:', 'data-testid="quiz-typing"']);
    expect(done).not.toContain('ant-skeleton');
    const arrived = renderTranscript(
      [msg('a1', 'assistant', [text('Right.'), recordCall(1), card(2), divider(1)])],
      { busy: true, status: 'streaming' }
    );
    expectInOrder(arrived, ['Right.', 'completed question 1:', 'Question 2 of 8']);

    // A refused record call holds nothing back.
    const refused = renderTranscript(
      [msg('a1', 'assistant', [{ ...pending(1), state: 'output-error', errorText: 'x' }, card(2)])],
      { busy: true, status: 'streaming' }
    );
    expect(refused).toContain('Question 2 of 8');
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
      const parts = [
        recordCall(1),
        { type: 'tool-present_question', toolCallId: 'call-q2', state: 'input-streaming', input },
        divider(1),
      ];
      expect(displayOrder(parts as never).map(e => e.index)).toEqual([0, 2, 1]);
      // The card opens no bubble while it arrives: the divider, then the activity line.
      const html = renderTranscript([msg('a1', 'assistant', parts)], {
        busy: true,
        status: 'streaming',
      });
      expectInOrder(html, ['completed question 1:', 'data-testid="quiz-typing"']);
      expect(html).not.toContain('ant-skeleton');
      expect(html).not.toContain('quiz-assistant-bubble');
    }
    // An arriving card numbered for the divider's own question stays above it.
    const own = renderTranscript(
      [
        ...EARLIER,
        msg('a1', 'assistant', [
          text('Here it is.'),
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
    expectInOrder(own, ['Here it is.', 'ant-skeleton', 'completed question 1:']);
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
    'This quiz reached its message limit and has been submitted.',
    "That message couldn't be sent. Please try again.",
    'This quiz has already started.',
    "This quiz isn't available right now. Please try again later.",
  ];

  it("shows every line the task's sanitizer sends, byte for byte", async () => {
    const { QUIZ_AGENT_ERROR_COPY } = await import('@classmoji/utils/quiz-agent');
    expect([...QUIZ_AGENT_ERROR_COPY]).toEqual(expect.arrayContaining(SANITIZER_COPY));
    for (const copy of [...SANITIZER_COPY, ...QUIZ_AGENT_ERROR_COPY]) {
      expect(FIXED_ERROR_COPY.has(copy)).toBe(true);
      expect(errorLineFor(new Error(copy))).toBe(copy);
    }
  });

  it("shows each refusal code's own line, a code added later included", async () => {
    // The chat knows no refusal code by name: whatever line the copy module
    // gives a code (classroom_locked, say) is shown as it is.
    const { QUIZ_REFUSAL_COPY } = await import('@classmoji/utils/quiz-agent');
    for (const copy of Object.values(QUIZ_REFUSAL_COPY)) {
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

describe('requestSession refusals', () => {
  const LOCKED = 'This class is in read-only mode. The owner has locked it.';
  const UNPUBLISHED = 'This class has been unpublished by the owner.';

  const refusedWith = async (status: number, body: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    );
    try {
      await requestSession('attempt-1');
    } catch (error) {
      return error as InstanceType<typeof QuizChatSessionError>;
    } finally {
      vi.unstubAllGlobals();
    }
    throw new Error('expected a refusal');
  };

  it("shows a locked class's own line, as the classroom-status gate answers it", async () => {
    const error = await refusedWith(403, { error: 'CLASSROOM_LOCKED', message: LOCKED });
    expect(error).toBeInstanceOf(QuizChatSessionError);
    expect(error.message).toBe(LOCKED);
    expect(error.code).toBe('CLASSROOM_LOCKED');
    expect(errorLineFor(error)).toBe(LOCKED);
    // A lock can be lifted: the chat stays open to try again.
    expect(isPermanentSessionRefusal(error)).toBe(false);

    const html = renderTranscript([], { errorLine: errorLineFor(error) });
    expect(html).toContain('data-testid="quiz-error"');
    expect(html).toContain('read-only mode');
    expect(html).not.toContain("The quiz couldn't start.");
  });

  it('shows the line for a classroom-status code when the body has no line of its own', async () => {
    const error = await refusedWith(403, { error: 'CLASSROOM_UNPUBLISHED' });
    expect(error.message).toBe(UNPUBLISHED);
    expect(errorLineFor(error)).toBe(UNPUBLISHED);
  });

  it("keeps the route's own coded refusals, and replaces text it doesn't know", async () => {
    const complete = await refusedWith(409, {
      code: 'QUIZ_COMPLETE',
      message: 'This quiz is already complete.',
    });
    expect(complete.message).toBe('This quiz is already complete.');
    expect(isPermanentSessionRefusal(complete)).toBe(true);

    const unknown = await refusedWith(500, { error: 'SOMETHING_ELSE', message: 'stack trace' });
    expect(unknown.message).toBe("The quiz couldn't start. Please try again.");
  });
});
