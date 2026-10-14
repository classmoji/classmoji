// @vitest-environment jsdom
/**
 * Code sandbox questions in the quiz chat (layout A: the sandbox in the
 * question card, a fresh one under the hint after Try again).
 *
 * - One Sandpack provider per sandbox for its whole life: live, locked (a
 *   reply or a capture running) and frozen are props, so the student's edits
 *   survive every change of state, a refused submission included.
 * - Submit is enabled only once the code ran, the files differ from the
 *   seed, and the chat can take a message; the capture locks the sandbox,
 *   the composer and the buttons; the message is the submission as its only
 *   part, exactly what `CodeSubmissionInputSchema` admits.
 * - A submission refused before admission leaves the chat and its sandbox
 *   unlocks; one whose reply failed leaves its sandbox open.
 * - Which sandbox is live is the shared rule's (`openSandboxOf`); the hint's
 *   sandbox renders wherever that rule counts it; the saved transcript shows
 *   every sandbox frozen, each with Run.
 * - A card shown again: its new instance is live and starts from the
 *   student's unsubmitted edits in the one before it, which stays frozen as
 *   it was; Submit still compares with the starter, Reset still writes it.
 * - Expand / Collapse switches only the layout's height, never the provider.
 *
 * Sandpack itself is faked (`@classmoji/ui-components/sandpack`): the fake
 * provider counts its mounts, holds editable files and answers the capture
 * when the test says so. The real useChat runs over a fake Trigger transport.
 */

import { act, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import {
  BUTTON_TEXT,
  CodeSubmissionInputSchema,
  QUIZ_REFUSAL_COPY,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ sendButtonTestId, disabled }: { sendButtonTestId?: string; disabled?: boolean }) => (
    <button data-testid={sendButtonTestId} disabled={disabled}>
      Send
    </button>
  ),
}));
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

// ── The fake Sandpack ────────────────────────────────────────────────────────

const sandpack = {
  mounts: 0,
  unmounts: 0,
  ready: true,
  loadFailed: false,
  captures: [] as string[][],
  /** Answers the pending capture with what the sandbox holds now. */
  finishCapture: null as null | ((extra?: Record<string, unknown>) => void),
};

type FakeState = {
  files: Record<string, string>;
  latest: { current: Record<string, string> };
  setFiles: (update: (files: Record<string, string>) => Record<string, string>) => void;
};
const FakeContext = createContext<FakeState | null>(null);

function FakeSandpackEmbed({
  files,
  options,
  readOnly,
  showPreview = true,
  previewPlaceholder,
  height,
  children,
}: {
  files: Record<string, string | { code: string }>;
  height?: number | string;
  options?: { visibleFiles?: string[] | null };
  readOnly?: boolean;
  showPreview?: boolean;
  previewPlaceholder?: ReactNode;
  children?: ReactNode;
}) {
  const [state, setState] = useState(() =>
    Object.fromEntries(
      Object.entries(files).map(([path, f]) => [path, typeof f === 'string' ? f : f.code])
    )
  );
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    sandpack.mounts++;
    return () => {
      sandpack.unmounts++;
    };
  }, []);
  const visible = options?.visibleFiles ?? Object.keys(state);
  return (
    <div
      data-testid="fake-sandpack"
      data-has-package-json={'/package.json' in state}
      data-height={String(height)}
    >
      {visible.map(path => (
        <textarea
          key={path}
          data-testid={`fake-editor-${path}`}
          readOnly={readOnly}
          value={state[path] ?? ''}
          onChange={e => {
            const value = e.target.value;
            setState(s => ({ ...s, [path]: value }));
          }}
        />
      ))}
      {showPreview ? <div data-testid="fake-preview" /> : previewPlaceholder}
      <FakeContext.Provider value={{ files: state, latest, setFiles: setState }}>
        {children}
      </FakeContext.Provider>
    </div>
  );
}

function useFakeSandboxCapture({ enabled }: { enabled: boolean }) {
  const ctx = useContext(FakeContext)!;
  return {
    capture: (paths: readonly string[]) =>
      new Promise(resolve => {
        sandpack.captures.push([...paths]);
        sandpack.finishCapture = (extra = {}) =>
          resolve({
            files: Object.fromEntries(paths.map(p => [p, ctx.latest.current[p]])),
            console: [{ method: 'log', text: 'Passed: 3' }],
            errors: [],
            timedOut: false,
            ...extra,
          });
      }),
    ready: enabled && sandpack.ready,
    loadFailed: enabled && sandpack.loadFailed,
    files: Object.fromEntries(Object.entries(ctx.files).map(([p, code]) => [p, { code }])),
    updateFiles: (next: Record<string, string>) => ctx.setFiles(s => ({ ...s, ...next })),
  };
}

vi.mock('@classmoji/ui-components/sandpack', async importOriginal => {
  const actual = await importOriginal<typeof import('@classmoji/ui-components/sandpack')>();
  return { ...actual, SandpackEmbed: FakeSandpackEmbed, useSandboxCapture: useFakeSandboxCapture };
});

// ── The fake transport (the real useChat reads it) ───────────────────────────

type SendOptions = { messages: QuizUIMessage[] };
const sends: SendOptions[] = [];
let sendChunks: UIMessageChunk[] = [];
let sendGate: Promise<void> | null = null;

const streamOf = (chunks: readonly UIMessageChunk[], gate: Promise<void> | null) =>
  new ReadableStream<UIMessageChunk>({
    async start(controller) {
      for (const [i, chunk] of chunks.entries()) {
        if (i === 1 && gate) await gate;
        controller.enqueue(chunk);
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      controller.close();
    },
  });

const fakeTransport = {
  sendMessages: vi.fn(async (options: SendOptions) => {
    sends.push(options);
    return streamOf(sendChunks, sendGate);
  }),
  reconnectToStream: vi.fn(async () => null),
  setSession: vi.fn(),
  getSession: () => undefined,
  sessionStatus: () => 'open',
};

vi.mock('@trigger.dev/sdk/chat/react', async () => {
  const actual = await vi.importActual<typeof import('@trigger.dev/sdk/chat/react')>(
    '@trigger.dev/sdk/chat/react'
  );
  return { ...actual, useTriggerChatTransport: () => fakeTransport };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let narrowScreen = false;
window.matchMedia = ((query: string) => ({
  matches: narrowScreen && query.includes('max-width'),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView ??= () => {};

const { default: QuizChat, QuizTranscript, withoutRefusedClick } = await import('../QuizChat');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const STARTER = {
  '/index.js': "const passed = [];\nconsole.log('Passed: ' + passed.length);",
  '/index.html': '<ul id="passed"></ul>',
};
const EDITED_JS = "const passed = [1, 2, 3];\nconsole.log('Passed: ' + passed.length);";
const ATTEMPT1 = { ...STARTER, '/index.js': EDITED_JS };

const msg = (id: string, role: 'user' | 'assistant', parts: unknown[], metadata?: unknown) =>
  ({ id, role, parts, ...(metadata ? { metadata } : {}) }) as unknown as QuizUIMessage;
const text = (t: string) => ({ type: 'text', text: t });

const CARD = {
  question_text: 'Fix `passed` so the page lists every student who passed, then submit your code.',
  sandbox: { template: 'vanilla', files: STARTER, active_file: '/index.js' },
};
const card = (n = 1) => ({
  type: 'tool-present_question',
  toolCallId: `call-q${n}`,
  state: 'output-available',
  input: { question_number: n, total_questions: 3, question_text: CARD.question_text },
  output: { card: CARD, question_number: n, total_questions: 3 },
});
const offer = (id: string, actions = ['try_again', 'next']) => ({
  type: 'tool-offer_next_step',
  toolCallId: id,
  state: 'output-available',
  input: { feedback: `Feedback ${id}`, actions },
  output: { actions, lead_in: 'Would you like to try again or move on?' },
});
/** A submission as the server stores it (its rendering for the model and status hidden). */
const storedSubmission = (
  id: string,
  sandbox: string,
  files: Record<string, string>,
  attempt = 1
) =>
  msg(
    id,
    'user',
    [
      {
        type: 'data-code-submission',
        data: {
          sandbox_id: sandbox,
          files,
          console: [{ method: 'log', text: 'Passed: 2' }],
          errors: [],
          question_number: 1,
          attempt,
          base_attempt: attempt === 1 ? null : attempt - 1,
          template: 'vanilla',
          changed_files: ['/index.js'],
        },
      },
      text('Code submission: question 1 …'),
      text('CURRENT STATUS …'),
    ],
    { hiddenPartIndexes: [1, 2] }
  );
const hintSandbox = (attempt = 2, files: Record<string, string> = ATTEMPT1) => ({
  type: 'data-sandbox',
  id: `sandbox-q1-${attempt}`,
  data: {
    id: `q1-${attempt}`,
    question_number: 1,
    attempt,
    seeded_from: attempt - 1,
    template: 'vanilla',
    files,
    active_file: '/index.js',
  },
});

const OPENING = [msg('a0', 'assistant', [text('Welcome.')]), msg('u0', 'user', [text('ready')])];
const QUESTION = [...OPENING, msg('a1', 'assistant', [card(1)])];

const textReply = (id: string, words: string): UIMessageChunk[] => [
  { type: 'start', messageId: id },
  { type: 'text-start', id: `${id}-t` },
  { type: 'text-delta', id: `${id}-t`, delta: words },
  { type: 'text-end', id: `${id}-t` },
  { type: 'finish' },
];

// ── Harness ──────────────────────────────────────────────────────────────────

const ATTEMPT = { id: 'attempt-sandbox', completed_at: null, evaluation_json: null };
const QUIZ = { id: 'quiz-1', question_count: 3 };

let container: HTMLDivElement;
let root: Root;

const settle = async (ms = 20) => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

const renderChat = async (transcript: QuizUIMessage[], owner = true) => {
  await act(async () => {
    root.render(
      <QuizChat
        quiz={QUIZ}
        attempt={ATTEMPT}
        transcript={transcript}
        viewerOwnsAttempt={owner}
        chatStarted
      />
    );
  });
  await settle();
};

const renderTranscript = async (
  messages: QuizUIMessage[],
  extra: Partial<Parameters<typeof QuizTranscript>[0]> = {}
) => {
  await act(async () => {
    root.render(
      <QuizTranscript
        messages={messages}
        status="ready"
        busy={false}
        isDarkMode={false}
        onButton={vi.fn()}
        sandboxControls={{ capturing: false, canSend: true, submit: vi.fn(async () => null) }}
        {...extra}
      />
    );
  });
};

const all = (testId: string) =>
  [...container.querySelectorAll(`[data-testid="${testId}"]`)] as HTMLElement[];
const one = (testId: string, within: ParentNode = container) =>
  within.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const sandboxes = () => all('quiz-sandbox');
const editor = (path = '/index.js', within: ParentNode = container) =>
  one(`fake-editor-${path}`, within) as HTMLTextAreaElement;
const submitButton = (within: ParentNode = container) =>
  one('quiz-sandbox-submit', within) as HTMLButtonElement;

const type = async (el: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.assign(sandpack, {
    mounts: 0,
    unmounts: 0,
    ready: true,
    loadFailed: false,
    captures: [],
    finishCapture: null,
  });
  sends.length = 0;
  sendChunks = [];
  sendGate = null;
  narrowScreen = false;
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/quiz-chat/session'
        ? new Response(JSON.stringify({ publicAccessToken: 'pat' }), { status: 200 })
        : new Response(JSON.stringify({ success: true }), { status: 200 })
    )
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('the live sandbox in the question card', () => {
  it('keeps one provider across live, locked and frozen, with the edits', async () => {
    let release!: () => void;
    sendGate = new Promise(resolve => (release = resolve));
    sendChunks = textReply('r1', 'Your list renders now.');
    await renderChat(QUESTION);

    expect(sandboxes()).toHaveLength(1);
    expect(sandboxes()[0].dataset.state).toBe('live');
    // Inside the card, under the question text, and the bubble is wide.
    expect(one('quiz-question-card')?.contains(sandboxes()[0])).toBe(true);
    expect(sandboxes()[0].getAttribute('aria-live')).toBe('off');
    // The vanilla template's hidden Babel pin rides along, never shown.
    expect(one('fake-sandpack')?.dataset.hasPackageJson).toBe('true');
    expect(one('fake-editor-/package.json')).toBeNull();
    expect(one('fake-preview')).not.toBeNull();

    await type(editor(), EDITED_JS);
    await act(async () => submitButton().click());

    // Capturing: the sandbox, the composer and Submit are locked.
    expect(sandpack.captures).toEqual([['/index.js', '/index.html']]);
    expect(sandboxes()[0].dataset.state).toBe('locked');
    expect(editor().readOnly).toBe(true);
    expect((one('quiz-send') as HTMLButtonElement).disabled).toBe(true);
    expect((one('quiz-sandbox-reset') as HTMLButtonElement).disabled).toBe(true);
    expect(sends).toHaveLength(0);

    await act(async () => sandpack.finishCapture!());
    await settle();

    // Sent as the message's only part, exactly the schema's input.
    expect(sends).toHaveLength(1);
    const sent = sends[0].messages.at(-1)!;
    expect(sent.role).toBe('user');
    expect(sent.parts).toEqual([
      {
        type: 'data-code-submission',
        data: {
          sandbox_id: 'q1-1',
          files: ATTEMPT1,
          console: [{ method: 'log', text: 'Passed: 3' }],
          errors: [],
        },
      },
    ]);
    const data = (sent.parts[0] as { data: unknown }).data;
    expect(CodeSubmissionInputSchema.safeParse(data).success).toBe(true);

    // The reply is running: still open (no standing reply yet), locked.
    expect(sandboxes()[0].dataset.state).toBe('locked');
    expect(one('quiz-sandbox-submission')?.textContent).toContain('Attempt 1');

    release();
    await settle(60);

    // The reply stands: frozen, the submitted files, no preview until Run.
    expect(sandboxes()[0].dataset.state).toBe('frozen');
    expect(editor().value).toBe(EDITED_JS);
    expect(editor().readOnly).toBe(true);
    expect(one('fake-preview')).toBeNull();
    expect(one('quiz-sandbox-run')).not.toBeNull();
    expect(one('quiz-sandbox-frozen')?.textContent).toContain('Attempt 1 submitted');
    expect(sandpack.mounts).toBe(1);
    expect(sandpack.unmounts).toBe(0);
  });

  it('enables Submit only once the code ran and differs from the seed', async () => {
    sandpack.ready = false;
    await renderChat(QUESTION);
    expect(submitButton().disabled).toBe(true);
    await type(editor(), EDITED_JS);
    expect(submitButton().disabled).toBe(true);

    sandpack.ready = true;
    await type(editor(), `${EDITED_JS} `);
    expect(submitButton().disabled).toBe(false);

    // Back to the starter: nothing to submit.
    await act(async () => one('quiz-sandbox-reset')!.click());
    expect(editor().value).toBe(STARTER['/index.js']);
    expect(submitButton().disabled).toBe(true);
    expect(one('quiz-sandbox-actions')?.textContent).toContain('Attempt 1');
  });

  it("offers a message instead when the code runner doesn't load", async () => {
    sandpack.ready = false;
    sandpack.loadFailed = true;
    await renderChat(QUESTION);
    expect(one('quiz-sandbox-load-failed')?.textContent).toBe(
      "The code runner didn't load. You can answer in a message instead."
    );
    // Read out, though the sandbox around it is aria-live="off".
    const status = one('quiz-sandbox-load-failed')!.closest('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(submitButton().disabled).toBe(true);
    expect((one('quiz-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('drops a submission refused before admission, and unlocks its sandbox with the edits', async () => {
    sendChunks = [
      { type: 'start', messageId: 'refused' },
      { type: 'error', errorText: QUIZ_REFUSAL_COPY.sandbox_closed },
    ];
    await renderChat(QUESTION);
    await type(editor(), EDITED_JS);
    await act(async () => submitButton().click());
    await act(async () => sandpack.finishCapture!());
    await settle(60);

    expect(sends).toHaveLength(1);
    expect(one('quiz-error')?.textContent).toContain(QUIZ_REFUSAL_COPY.sandbox_closed);
    expect(one('quiz-sandbox-submission')).toBeNull();
    expect(sandboxes()[0].dataset.state).toBe('live');
    expect(editor().value).toBe(EDITED_JS);
    expect(editor().readOnly).toBe(false);
    expect(submitButton().disabled).toBe(false);
    expect(sandpack.mounts).toBe(1);
  });

  it.each([
    ['invalid_submission', QUIZ_REFUSAL_COPY.invalid_submission],
    ['reserved_code', QUIZ_REFUSAL_COPY.reserved_code],
  ])('drops a submission refused %s the same way', async (_code, line) => {
    sendChunks = [
      { type: 'start', messageId: 'refused' },
      { type: 'error', errorText: line },
    ];
    await renderChat(QUESTION);
    await type(editor(), EDITED_JS);
    await act(async () => submitButton().click());
    await act(async () => sandpack.finishCapture!());
    await settle(60);
    expect(one('quiz-error')?.textContent).toContain(line);
    expect(one('quiz-sandbox-submission')).toBeNull();
    expect(sandboxes()[0].dataset.state).toBe('live');
    expect(editor().value).toBe(EDITED_JS);
  });

  it('leaves the sandbox open when the reply to a submission failed', async () => {
    sendChunks = [
      { type: 'start', messageId: 'failed' },
      { type: 'data-notice', data: { code: 'reply_failed' } } as UIMessageChunk,
      { type: 'finish' },
    ];
    await renderChat(QUESTION);
    await type(editor(), EDITED_JS);
    await act(async () => submitButton().click());
    await act(async () => sandpack.finishCapture!());
    await settle(60);

    // The submission was admitted (it stays), but nothing answered it.
    expect(one('quiz-sandbox-submission')).not.toBeNull();
    expect(sandboxes()[0].dataset.state).toBe('live');
    expect(editor().value).toBe(EDITED_JS);
    expect(submitButton().disabled).toBe(false);
  });

  it('refuses code over the submission caps without sending it', async () => {
    await renderChat(QUESTION);
    await type(editor(), 'x'.repeat(10_001));
    await act(async () => submitButton().click());
    await act(async () => sandpack.finishCapture!());
    await settle();
    expect(sends).toHaveLength(0);
    expect(one('quiz-sandbox-line')?.textContent).toBe(
      'This code is too long to submit. Shorten it and try again.'
    );
    expect(one('quiz-sandbox-line')!.closest('[role="status"]')).not.toBeNull();
    expect(sandboxes()[0].dataset.state).toBe('live');
  });

  it('locks the buttons while a capture runs', async () => {
    await renderChat([
      ...QUESTION,
      msg('u1', 'user', [text('Can I just explain it?')]),
      msg('a2', 'assistant', [offer('o1')]),
    ]);
    expect((one('quiz-next') as HTMLButtonElement).disabled).toBe(false);
    await type(editor(), EDITED_JS);
    await act(async () => submitButton().click());
    expect((one('quiz-next') as HTMLButtonElement).disabled).toBe(true);
    expect((one('quiz-try-again') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => sandpack.finishCapture!({ files: {} }));
    await settle();
  });
});

describe('the hint sandbox after Try again', () => {
  const ANSWERED = [
    ...QUESTION,
    storedSubmission('u1', 'q1-1', ATTEMPT1),
    msg('a2', 'assistant', [offer('o1')]),
    msg('u2', 'user', [text(BUTTON_TEXT.try_again)], { action: 'try_again' }),
  ];

  it('renders live at the foot of the hint, the card frozen with its submission', async () => {
    await renderTranscript([
      ...ANSWERED,
      msg('a3', 'assistant', [hintSandbox(2), text('Look at the boundary again.')]),
    ]);
    const [cardSandbox, hint] = sandboxes();
    expect(cardSandbox.dataset.sandboxId).toBe('q1-1');
    expect(cardSandbox.dataset.state).toBe('frozen');
    expect(one('quiz-sandbox-frozen', cardSandbox)?.textContent).toContain('Attempt 1 submitted');
    expect(editor('/index.js', cardSandbox).value).toBe(EDITED_JS);

    expect(hint.dataset.sandboxId).toBe('q1-2');
    expect(hint.dataset.state).toBe('live');
    expect(one('quiz-sandbox-actions', hint)?.textContent).toContain(
      'Attempt 2 · starts from attempt 1'
    );
    // In the hint's bubble, above its Next.
    const bubble = hint.closest('[data-testid="quiz-assistant-bubble"]')!;
    expect(bubble.textContent).toContain('Look at the boundary again.');
    const next = one('quiz-next', bubble)!;
    expect(hint.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Seeded from attempt 1: unchanged, nothing to submit; the starter differs.
    expect(submitButton(hint).disabled).toBe(true);
    await act(async () => one('quiz-sandbox-reset', hint)!.click());
    expect(editor('/index.js', hint).value).toBe(STARTER['/index.js']);
    expect(submitButton(hint).disabled).toBe(false);
  });

  it('is not shown on a reply that showed no hint, nor with an id the server would not give', async () => {
    await renderTranscript([
      ...ANSWERED,
      msg('a3', 'assistant', [
        hintSandbox(2),
        text('Look again.'),
        { type: 'data-notice', data: { code: 'reply_failed' } },
      ]),
    ]);
    expect(sandboxes().map(s => s.dataset.sandboxId)).toEqual(['q1-1']);

    await renderTranscript([
      ...ANSWERED,
      msg('a3', 'assistant', [
        { ...hintSandbox(2), data: { ...hintSandbox(2).data, id: 'q1-9' } },
        text('Look again.'),
      ]),
    ]);
    expect(sandboxes().map(s => s.dataset.sandboxId)).toEqual(['q1-1']);
  });

  it('stays mounted when a late chunk turns its reply back to streaming', async () => {
    const hintReply = msg('a3', 'assistant', [hintSandbox(2), text('Look again.')]);
    await renderTranscript([...ANSWERED, hintReply]);
    await type(editor('/index.js', sandboxes()[1]), `${EDITED_JS}\n// mine`);
    const mounts = sandpack.mounts;

    await renderTranscript([...ANSWERED, hintReply], { busy: true });
    await renderTranscript(
      [...ANSWERED, msg('a3', 'assistant', [hintSandbox(2), text('Look again. More.')])],
      { busy: false }
    );
    expect(sandpack.mounts).toBe(mounts);
    expect(editor('/index.js', sandboxes()[1]).value).toBe(`${EDITED_JS}\n// mine`);
  });

  it('shows the second submission diffed against attempt 1', async () => {
    await renderTranscript([
      ...ANSWERED,
      msg('a3', 'assistant', [hintSandbox(2), text('Look again.')]),
      storedSubmission(
        'u3',
        'q1-2',
        { ...ATTEMPT1, '/index.js': EDITED_JS.replace('[1, 2, 3]', '[1, 2, 3, 4]') },
        2
      ),
    ]);
    const cards = all('quiz-sandbox-submission');
    expect(cards).toHaveLength(2);
    expect(cards[1].textContent).toContain('Attempt 2');
    const changed = [...cards[1].querySelectorAll('[data-diff]')].map(
      row => `${(row as HTMLElement).dataset.diff}${row.lastElementChild?.textContent}`
    );
    expect(changed).toContain('-const passed = [1, 2, 3];');
    expect(changed).toContain('+const passed = [1, 2, 3, 4];');
  });
});

describe('the saved transcript', () => {
  it('shows every sandbox frozen, and Run mounts only that preview', async () => {
    await renderChat(
      [
        ...QUESTION,
        storedSubmission('u1', 'q1-1', ATTEMPT1),
        msg('a2', 'assistant', [offer('o1')]),
        msg('u2', 'user', [text(BUTTON_TEXT.try_again)], { action: 'try_again' }),
        msg('a3', 'assistant', [hintSandbox(2), text('Look again.')]),
      ],
      false
    );
    expect(sandboxes().map(s => s.dataset.state)).toEqual(['frozen', 'frozen']);
    expect(one('quiz-sandbox-submit')).toBeNull();
    expect(all('fake-preview')).toHaveLength(0);
    expect(one('quiz-sandbox-frozen', sandboxes()[1])?.textContent).toContain('Not submitted');

    const mounts = sandpack.mounts;
    await act(async () => one('quiz-sandbox-run', sandboxes()[0])!.click());
    expect(one('fake-preview', sandboxes()[0])).not.toBeNull();
    expect(one('fake-preview', sandboxes()[1])).toBeNull();
    expect(sandpack.mounts).toBe(mounts);
  });
});

describe('a card shown again', () => {
  /** The agent shows question 1's card again, in a reply to a typed message. */
  const RESHOWN = [
    ...QUESTION,
    msg('u1', 'user', [text('Can you show the question again?')]),
    msg('a2', 'assistant', [{ ...card(1), toolCallId: 'call-q1-again' }]),
  ];

  it('starts the new live instance from the edits, the older copy frozen as it was', async () => {
    await renderTranscript(QUESTION);
    await type(editor(), EDITED_JS);
    expect(sandpack.mounts).toBe(1);

    await renderTranscript(RESHOWN);
    const [older, newer] = sandboxes();
    expect(sandboxes().map(s => s.dataset.sandboxId)).toEqual(['q1-1', 'q1-1']);
    expect(sandpack.mounts).toBe(2);
    expect(sandpack.unmounts).toBe(0);

    // The older copy: frozen, showing what it showed, with the way down.
    expect(older.dataset.state).toBe('frozen');
    expect(editor('/index.js', older).value).toBe(EDITED_JS);
    expect(one('quiz-sandbox-frozen', older)?.textContent).toContain('Not submitted');
    expect(one('quiz-sandbox-go-live', older)?.textContent).toBe('Continue in the sandbox below');

    // The new one: live, from the edits, every other file from its seed.
    expect(newer.dataset.state).toBe('live');
    expect(editor('/index.js', newer).value).toBe(EDITED_JS);
    expect(editor('/index.html', newer).value).toBe(STARTER['/index.html']);
    expect(editor('/index.js', newer).readOnly).toBe(false);
    // Still an edit against the starter: Submit is on without typing.
    expect(submitButton(newer).disabled).toBe(false);
    // Reset writes the starter, and then there is nothing to submit.
    await act(async () => one('quiz-sandbox-reset', newer)!.click());
    expect(editor('/index.js', newer).value).toBe(STARTER['/index.js']);
    expect(submitButton(newer).disabled).toBe(true);
    // The older copy did not follow.
    expect(editor('/index.js', older).value).toBe(EDITED_JS);
  });

  it('carries the latest edits again when the card is shown a third time', async () => {
    await renderTranscript(QUESTION);
    await type(editor(), EDITED_JS);
    await renderTranscript(RESHOWN);
    await type(editor('/index.js', sandboxes()[1]), `${EDITED_JS}\n// second`);

    await renderTranscript([
      ...RESHOWN,
      msg('u2', 'user', [text('Once more?')]),
      msg('a3', 'assistant', [{ ...card(1), toolCallId: 'call-q1-third' }]),
    ]);
    const states = sandboxes().map(s => s.dataset.state);
    expect(states).toEqual(['frozen', 'frozen', 'live']);
    expect(editor('/index.js', sandboxes()[0]).value).toBe(EDITED_JS);
    expect(editor('/index.js', sandboxes()[1]).value).toBe(`${EDITED_JS}\n// second`);
    expect(editor('/index.js', sandboxes()[2]).value).toBe(`${EDITED_JS}\n// second`);
  });

  it('starts from the starter after a reload (nothing carries across one)', async () => {
    await renderTranscript(RESHOWN);
    const [older, newer] = sandboxes();
    expect(older.dataset.state).toBe('frozen');
    expect(newer.dataset.state).toBe('live');
    expect(editor('/index.js', newer).value).toBe(STARTER['/index.js']);
    expect(submitButton(newer).disabled).toBe(true);
  });

  it('carries nothing in a read-only view', async () => {
    await renderTranscript(QUESTION, { sandboxControls: null });
    await renderTranscript(RESHOWN, { sandboxControls: null });
    expect(sandboxes().map(s => s.dataset.state)).toEqual(['frozen', 'frozen']);
    expect(editor('/index.js', sandboxes()[1]).value).toBe(STARTER['/index.js']);
  });

  it("never seeds a hint sandbox from the card's edits (another id)", async () => {
    await renderTranscript(QUESTION);
    await type(editor(), `${EDITED_JS}\n// unsent`);
    await renderTranscript([
      ...QUESTION,
      storedSubmission('u1', 'q1-1', ATTEMPT1),
      msg('a2', 'assistant', [offer('o1')]),
      msg('u2', 'user', [text(BUTTON_TEXT.try_again)], { action: 'try_again' }),
      msg('a3', 'assistant', [hintSandbox(2), text('Look again.')]),
    ]);
    const hint = sandboxes()[1];
    expect(hint.dataset.sandboxId).toBe('q1-2');
    expect(editor('/index.js', hint).value).toBe(EDITED_JS);
  });
});

describe('Expand', () => {
  const height = (sandbox: HTMLElement) => one('fake-sandpack', sandbox)?.dataset.height;
  const toggle = (sandbox: HTMLElement) => one('quiz-sandbox-expand', sandbox) as HTMLButtonElement;

  it('switches the live sandbox between its height and a tall one, same provider', async () => {
    await renderChat(QUESTION);
    const [sandbox] = sandboxes();
    await type(editor(), EDITED_JS);
    expect(height(sandbox)).toBe('320');
    expect(toggle(sandbox).textContent).toBe('Expand');
    expect(toggle(sandbox).dataset.expanded).toBe('false');
    // Its icon and visible text: the text is the accessible name.
    expect(toggle(sandbox).querySelector('.anticon-expand-alt')).not.toBeNull();

    await act(async () => toggle(sandbox).click());
    expect(height(sandbox)).toBe('640');
    expect(toggle(sandbox).textContent).toBe('Collapse');
    expect(toggle(sandbox).querySelector('.anticon-shrink')).not.toBeNull();
    // Nothing remounted: the edits and the running preview are as they were.
    expect(sandpack.mounts).toBe(1);
    expect(sandpack.unmounts).toBe(0);
    expect(editor().value).toBe(EDITED_JS);
    expect(one('fake-preview', sandbox)).not.toBeNull();
    expect(submitButton().disabled).toBe(false);

    await act(async () => toggle(sandbox).click());
    expect(height(sandbox)).toBe('320');
    expect(sandpack.mounts).toBe(1);
  });

  it('is there on a frozen sandbox, with Run, and keeps a running preview', async () => {
    await renderChat([...QUESTION, storedSubmission('u1', 'q1-1', ATTEMPT1)], false);
    const [sandbox] = sandboxes();
    expect(sandbox.dataset.state).toBe('frozen');
    expect(height(sandbox)).toBe('230');
    await act(async () => one('quiz-sandbox-run', sandbox)!.click());
    await act(async () => toggle(sandbox).click());
    expect(height(sandbox)).toBe('640');
    expect(one('fake-preview', sandbox)).not.toBeNull();
    expect(sandpack.mounts).toBe(1);
  });

  it('scales in the narrow column', async () => {
    narrowScreen = true;
    await renderChat(QUESTION);
    const [sandbox] = sandboxes();
    expect(height(sandbox)).toBe('460');
    await act(async () => toggle(sandbox).click());
    expect(height(sandbox)).toBe('920');
  });

  it('stays usable while the sandbox is locked', async () => {
    await renderTranscript(QUESTION, { busy: true });
    const [sandbox] = sandboxes();
    expect(sandbox.dataset.state).toBe('locked');
    expect(toggle(sandbox).disabled).toBe(false);
    await act(async () => toggle(sandbox).click());
    expect(height(sandbox)).toBe('640');
  });
});

describe('a narrow screen', () => {
  it('puts the sandbox under the card, at the column width', async () => {
    narrowScreen = true;
    await renderChat(QUESTION);
    const [sandbox] = sandboxes();
    expect(one('quiz-question-card')?.contains(sandbox)).toBe(false);
    expect(sandbox.closest('[data-testid="quiz-sandbox-row"]')).not.toBeNull();
    expect(sandbox.dataset.state).toBe('live');
  });
});

describe('withoutRefusedClick', () => {
  it('drops a refused submission and the empty reply it opened', () => {
    const submission = msg('u1', 'user', [
      {
        type: 'data-code-submission',
        data: { sandbox_id: 'q1-1', files: {}, console: [], errors: [] },
      },
    ]);
    expect(withoutRefusedClick([...QUESTION, submission, msg('r', 'assistant', [])])).toEqual(
      QUESTION
    );
    expect(withoutRefusedClick([...QUESTION, msg('u1', 'user', [text('my answer')])])).toBeNull();
  });
});
