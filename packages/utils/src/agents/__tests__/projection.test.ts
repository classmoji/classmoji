import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { quizStaffVisibility, quizVisibility, type QuizUIMessage } from '../../quizAgent/index.ts';
import {
  createChunkProjector,
  projectMessage,
  projectTranscript,
  toolVisibility,
} from '../projection.ts';

type Chunk = UIMessageChunk<any, any>;

const card = {
  preamble: 'Next one.',
  question_number: 2,
  total_questions: 8,
  question_text: 'What does this selector match?',
  code_snippet: 'nav > a { color: red; }',
  code_language: 'css',
};

// present_question's input in a code-aware attempt: the card with the quote the
// server resolves in place of typed code. The viewer receives the card the
// server filled (the output), never the quote.
const quote = {
  path: 'css/style.css',
  ranges: [[11, 15]],
  anchor: '.features {',
  edit: { line: 13, replace: '  grid-template-columns: 1fr;' },
};
const { code_snippet: _typed, ...cardFields } = card;
const quotedInput = { ...cardFields, code_quote: quote };
const quotedOutput = {
  card: {
    ...cardFields,
    code_snippet: '.features {\n  display: grid;\n  grid-template-columns: 1fr;\n...\n}',
    source: { path: 'css/style.css', lines: '11-15', changed: true },
  },
  question_number: 2,
  total_questions: 8,
};

/** None of the quote's own terms (or raw input text) in what the viewer receives. */
const expectNoQuote = (value: unknown) => {
  const s = JSON.stringify(value);
  for (const term of ['code_quote', '"ranges"', '"anchor"', '"edit"', '"replace"', 'rawInput']) {
    expect(s).not.toContain(term);
  }
};

// offer_next_step's input: the correct answer (staff only), then the feedback
// and the buttons. The answer is a sentinel, so a test can look for its value
// (not just its key) in everything a student receives.
const ANSWER = 'SENTINEL-the-text-is-white';
const offerInput = {
  expected_answer: ANSWER,
  feedback: 'Check which of the two selectors is more specific.',
  actions: ['try_again', 'next'],
};
const { expected_answer: _answer, ...offerShown } = offerInput;
const offerOutput = {
  actions: ['try_again', 'next'],
  lead_in: 'Would you like to try again or move on?',
};
/** The model's streamed input text, cut so the answer spans two deltas. */
const offerDeltas = (toolCallId: string): Chunk[] =>
  [
    '{"expected_answer":"SENTINEL-the-',
    'text-is-white","feedback":"Check which of the two',
    ' selectors is more specific.","actions":["try_again","next"]}',
  ].map(inputTextDelta => ({ type: 'tool-input-delta', toolCallId, inputTextDelta }));

/** Neither the answer's value, nor any piece of it, nor its key, in what a student receives. */
const expectNoAnswer = (value: unknown) => {
  const s = JSON.stringify(value);
  for (const term of ['SENTINEL', 'text-is-white', 'expected_answer', 'rawInput']) {
    expect(s).not.toContain(term);
  }
};

const project = (chunks: Chunk[]) => {
  const p = createChunkProjector<Chunk>(quizVisibility);
  return chunks.map(c => p(c)).filter((c): c is Chunk => c !== null);
};

describe('createChunkProjector: every v7 chunk type', () => {
  const passes: Chunk[] = [
    { type: 'start', messageId: 'm1' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Hi' },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'reset-step' },
    { type: 'message-metadata', messageMetadata: { action: 'next' } },
    { type: 'error', errorText: 'An error occurred.' },
    { type: 'abort', reason: 'stopped' },
    { type: 'finish', finishReason: 'stop' },
  ];

  it.each(passes.map(c => [c.type, c] as const))('passes %s unchanged', (_t, chunk) => {
    expect(createChunkProjector(quizVisibility)(chunk)).toBe(chunk);
  });

  const drops: Chunk[] = [
    { type: 'reasoning-start', id: 'r1' },
    { type: 'reasoning-delta', id: 'r1', delta: 'secret thought' },
    { type: 'reasoning-end', id: 'r1', providerMetadata: { anthropic: { signature: 'sig' } } },
    { type: 'reasoning-file', url: 'data:text/plain;base64,eA==', mediaType: 'text/plain' },
    { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
    { type: 'source-document', sourceId: 's2', mediaType: 'text/plain', title: 'Doc' },
    { type: 'file', url: 'data:text/plain;base64,eA==', mediaType: 'text/plain' },
    { type: 'custom', kind: 'anthropic.thing' },
    { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
    { type: 'tool-approval-response', approvalId: 'a1', approved: true },
    { type: 'data-unknown', data: { x: 1 } },
  ];

  it.each(drops.map(c => [c.type, c] as const))('drops %s', (_t, chunk) => {
    expect(createChunkProjector(quizVisibility)(chunk)).toBeNull();
  });

  it('drops an unknown chunk type', () => {
    expect(
      createChunkProjector(quizVisibility)({ type: 'something-new' } as unknown as Chunk)
    ).toBeNull();
  });

  it('passes every chunk of a shown tool call without hidden input keys', () => {
    const chunks: Chunk[] = [
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'submit_quiz_evaluation' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"final_ack' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'submit_quiz_evaluation',
        input: { final_acknowledgment: 'Well done.' },
      },
      { type: 'tool-output-available', toolCallId: 'c1', output: { v: 2 } },
      { type: 'tool-output-error', toolCallId: 'c1', errorText: 'refused' },
      { type: 'tool-output-denied', toolCallId: 'c1' },
    ];
    expect(project(chunks)).toEqual(chunks);
  });

  it.each([
    'record_question_result',
    'explore_codebase',
    'some_mcp_tool',
    'constructor',
    '__proto__',
  ])('drops every chunk of %s (hidden, label or undeclared)', toolName => {
    const chunks: Chunk[] = [
      { type: 'tool-input-start', toolCallId: 'c9', toolName },
      { type: 'tool-input-delta', toolCallId: 'c9', inputTextDelta: '{"focus_area":"auth"}' },
      { type: 'tool-input-available', toolCallId: 'c9', toolName, input: { focus_area: 'auth' } },
      { type: 'tool-input-error', toolCallId: 'c9', toolName, input: {}, errorText: 'bad' },
      { type: 'tool-output-available', toolCallId: 'c9', output: { excerpts: 'code' } },
      { type: 'tool-output-error', toolCallId: 'c9', errorText: 'boom' },
      { type: 'tool-output-denied', toolCallId: 'c9' },
    ];
    expect(project(chunks)).toEqual([]);
  });

  it('drops chunks for a toolCallId never named', () => {
    expect(
      project([
        { type: 'tool-input-delta', toolCallId: 'x', inputTextDelta: '{}' },
        { type: 'tool-output-available', toolCallId: 'x', output: { card } },
        { type: 'tool-output-error', toolCallId: 'x', errorText: 'e' },
      ])
    ).toEqual([]);
  });

  it('keeps a call hidden when a later chunk names a shown tool for the same id', () => {
    expect(
      project([
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'record_question_result' },
        {
          type: 'tool-input-available',
          toolCallId: 'c1',
          toolName: 'present_question',
          input: card,
        },
        { type: 'tool-output-available', toolCallId: 'c1', output: {} },
      ])
    ).toEqual([]);
  });

  it('passes an invalid call of a shown tool, flagged dynamic', () => {
    const chunk: Chunk = {
      type: 'tool-input-error',
      toolCallId: 'c2',
      toolName: 'present_question',
      input: { question_number: 'two' },
      errorText: 'Invalid input',
      dynamic: true,
    };
    expect(project([chunk])).toEqual([chunk]);
  });

  it('re-validates a data-step and strips every field but kind, path and error', () => {
    expect(
      project([
        {
          type: 'data-step',
          id: 's1',
          data: { kind: 'read_file', path: 'src/App.jsx', focus_area: 'auth', question: 'why?' },
          transient: false,
          extra: 'x',
        } as Chunk,
      ])
    ).toEqual([
      {
        type: 'data-step',
        id: 's1',
        data: { kind: 'read_file', path: 'src/App.jsx' },
        transient: false,
      },
    ]);
  });

  it.each([
    ['another kind', { kind: 'search_code', path: 'x' }],
    ['no path', { kind: 'read_file' }],
    ['a non-string path', { kind: 'read_file', path: 42 }],
    ['a course title over the limit', { kind: 'course_material', title: 'x'.repeat(201) }],
    ['an empty course title', { kind: 'course_material', title: '' }],
    ['a non-string course title', { kind: 'course_material', title: 7 }],
  ])('drops a data-step with %s', (_l, data) => {
    expect(project([{ type: 'data-step', data } as Chunk])).toEqual([]);
  });

  it('passes a course-material step with its title only: no query, id, kind of document or text', () => {
    expect(
      project([
        {
          type: 'data-step',
          data: {
            kind: 'course_material',
            title: 'Semantic HTML',
            query: 'what does nav mark up',
            docKind: 'page',
            id: 'page-1',
            text: 'The nav element...',
            path: 'bot-context/notes.md',
          },
        } as Chunk,
        {
          type: 'data-step',
          data: { kind: 'course_material', query: 'what does nav mark up' },
        } as Chunk,
      ])
    ).toEqual([
      { type: 'data-step', data: { kind: 'course_material', title: 'Semantic HTML' } },
      { type: 'data-step', data: { kind: 'course_material' } },
    ]);
  });

  it('drops every chunk of the content tools, live', () => {
    expect(
      project([
        { type: 'tool-input-start', toolCallId: 'k1', toolName: 'content_get' },
        { type: 'tool-input-delta', toolCallId: 'k1', inputTextDelta: '{"kind":"page"' },
        {
          type: 'tool-input-available',
          toolCallId: 'k1',
          toolName: 'content_get',
          input: { kind: 'page', id: 'page-1' },
        },
        { type: 'tool-output-available', toolCallId: 'k1', output: 'The nav element...' },
        {
          type: 'tool-input-available',
          toolCallId: 'k2',
          toolName: 'content_search',
          input: { query: 'what does nav mark up' },
        },
        { type: 'tool-output-error', toolCallId: 'k2', errorText: 'Search could not run' },
      ] as Chunk[])
    ).toEqual([]);
  });

  it('re-validates question-result, notice and evaluation parts', () => {
    const evaluation = {
      v: 2,
      source: 'server',
      partial_credit_percentage: 50,
      first_attempt_percentage: 0,
      question_results: [],
      debug: 'x',
    };
    expect(
      project([
        {
          type: 'data-question-result',
          data: { question_num: 1, emoji: 'rocket', brief_feedback: 'ok', credit_earned: 100 },
        },
        { type: 'data-notice', data: { code: 'reply_failed', detail: 'stack' } },
        { type: 'data-notice', data: { code: 'budget_exceeded' } },
        { type: 'data-evaluation', data: evaluation },
      ])
    ).toEqual([
      {
        type: 'data-question-result',
        data: { question_num: 1, emoji: 'rocket', brief_feedback: 'ok' },
      },
      { type: 'data-notice', data: { code: 'reply_failed' } },
      {
        type: 'data-evaluation',
        data: {
          v: 2,
          source: 'server',
          partial_credit_percentage: 50,
          first_attempt_percentage: 0,
          question_results: [],
        },
      },
    ]);
  });

  it('keeps separate state per projector', () => {
    const a = createChunkProjector<Chunk>(quizVisibility);
    const b = createChunkProjector<Chunk>(quizVisibility);
    a({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'present_question' });
    expect(b({ type: 'tool-output-available', toolCallId: 'c1', output: {} })).toBeNull();
  });
});

describe('hidden input keys: present_question code_quote', () => {
  it('sends the call cut, with no streamed input, and the output as it is', () => {
    const out = project([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'present_question' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"question_number":2,' },
      {
        type: 'tool-input-delta',
        toolCallId: 'c1',
        inputTextDelta: `"code_quote":${JSON.stringify(quote)}}`,
      },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'present_question',
        input: quotedInput,
      },
      { type: 'tool-output-available', toolCallId: 'c1', output: quotedOutput },
    ]);
    expect(out).toEqual([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'present_question' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'present_question',
        input: cardFields,
      },
      { type: 'tool-output-available', toolCallId: 'c1', output: quotedOutput },
    ]);
    expectNoQuote(out);
  });

  it('cuts an invalid call, and sends no input when it is raw text', () => {
    const out = project([
      {
        type: 'tool-input-error',
        toolCallId: 'c2',
        toolName: 'present_question',
        input: { question_number: 'two', code_quote: quote },
        errorText: 'Invalid input',
        dynamic: true,
      },
      {
        type: 'tool-input-error',
        toolCallId: 'c3',
        toolName: 'present_question',
        input: `{"question_number":2,"code_quote":${JSON.stringify(quote)}`,
        errorText: 'Invalid input',
      },
    ]);
    expect(out).toEqual([
      {
        type: 'tool-input-error',
        toolCallId: 'c2',
        toolName: 'present_question',
        input: { question_number: 'two' },
        errorText: 'Invalid input',
        dynamic: true,
      },
      {
        type: 'tool-input-error',
        toolCallId: 'c3',
        toolName: 'present_question',
        input: undefined,
        errorText: 'Invalid input',
      },
    ]);
    expectNoQuote(out);
  });

  it('cuts stored parts: complete, refused, and still streaming when the turn ended', () => {
    const m = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-present_question',
          toolCallId: 'c1',
          state: 'output-available',
          input: quotedInput,
          output: quotedOutput,
        },
        {
          type: 'dynamic-tool',
          toolName: 'present_question',
          toolCallId: 'c2',
          state: 'output-error',
          input: { question_number: 'two', code_quote: quote },
          errorText: 'Invalid input',
        },
        {
          type: 'tool-present_question',
          toolCallId: 'c3',
          state: 'input-streaming',
          input: { question_number: 3, code_quote: quote },
          rawInput: `{"question_number":3,"code_quote":${JSON.stringify(quote)}`,
        },
      ],
    } as unknown as QuizUIMessage;
    const copy = structuredClone(m);
    const stored = projectMessage(m, quizVisibility)!;
    expect(stored.parts).toEqual([
      {
        type: 'tool-present_question',
        toolCallId: 'c1',
        state: 'output-available',
        input: cardFields,
        output: quotedOutput,
      },
      {
        type: 'dynamic-tool',
        toolName: 'present_question',
        toolCallId: 'c2',
        state: 'output-error',
        input: { question_number: 'two' },
        errorText: 'Invalid input',
      },
      {
        type: 'tool-present_question',
        toolCallId: 'c3',
        state: 'input-streaming',
        input: undefined,
      },
    ]);
    expectNoQuote(stored);
    expect(m).toEqual(copy);
  });
});

describe('hidden input keys: offer_next_step expected_answer', () => {
  it('sends a student no streamed input, and the call without the answer', () => {
    const chunks: Chunk[] = [
      { type: 'tool-input-start', toolCallId: 'o1', toolName: 'offer_next_step' },
      ...offerDeltas('o1'),
      {
        type: 'tool-input-available',
        toolCallId: 'o1',
        toolName: 'offer_next_step',
        input: offerInput,
      },
      { type: 'tool-output-available', toolCallId: 'o1', output: offerOutput },
    ];
    const out = project(chunks);
    expect(out).toEqual([
      { type: 'tool-input-start', toolCallId: 'o1', toolName: 'offer_next_step' },
      {
        type: 'tool-input-available',
        toolCallId: 'o1',
        toolName: 'offer_next_step',
        input: offerShown,
      },
      { type: 'tool-output-available', toolCallId: 'o1', output: offerOutput },
    ]);
    // Not one delta reaches the student: their text is raw JSON with the answer in it.
    expect(out.some(c => c.type === 'tool-input-delta')).toBe(false);
    expectNoAnswer(out);
  });

  it('sends no delta even when the answer comes last, or a delta arrives before the call is named', () => {
    const p = createChunkProjector<Chunk>(quizVisibility);
    const out = [
      // A delta for an id not yet named is dropped.
      {
        type: 'tool-input-delta',
        toolCallId: 'o2',
        inputTextDelta: `{"expected_answer":"${ANSWER}"`,
      },
      { type: 'tool-input-start', toolCallId: 'o2', toolName: 'offer_next_step' },
      { type: 'tool-input-delta', toolCallId: 'o2', inputTextDelta: '{"feedback":"Check it.",' },
      {
        type: 'tool-input-delta',
        toolCallId: 'o2',
        inputTextDelta: `"expected_answer":"${ANSWER}"}`,
      },
    ]
      .map(c => p(c as Chunk))
      .filter(c => c !== null);
    expect(out).toEqual([
      { type: 'tool-input-start', toolCallId: 'o2', toolName: 'offer_next_step' },
    ]);
    expectNoAnswer(out);
  });

  it('cuts an invalid call, and sends no input when it is raw text', () => {
    const out = project([
      {
        type: 'tool-input-error',
        toolCallId: 'o3',
        toolName: 'offer_next_step',
        input: { ...offerInput, actions: ['try_again'] },
        errorText: 'Invalid input',
        dynamic: true,
      },
      {
        type: 'tool-input-error',
        toolCallId: 'o4',
        toolName: 'offer_next_step',
        input: `{"expected_answer":"${ANSWER}","feedback":"Chec`,
        errorText: 'Invalid input',
      },
    ]);
    expect(out).toEqual([
      {
        type: 'tool-input-error',
        toolCallId: 'o3',
        toolName: 'offer_next_step',
        input: { ...offerShown, actions: ['try_again'] },
        errorText: 'Invalid input',
        dynamic: true,
      },
      {
        type: 'tool-input-error',
        toolCallId: 'o4',
        toolName: 'offer_next_step',
        input: undefined,
        errorText: 'Invalid input',
      },
    ]);
    expectNoAnswer(out);
  });

  const storedOffers = {
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-offer_next_step',
        toolCallId: 'o1',
        state: 'output-available',
        input: offerInput,
        output: offerOutput,
      },
      {
        type: 'dynamic-tool',
        toolName: 'offer_next_step',
        toolCallId: 'o2',
        state: 'output-error',
        input: { ...offerInput, actions: ['try_again'] },
        errorText: 'Invalid input',
      },
      {
        type: 'tool-offer_next_step',
        toolCallId: 'o3',
        state: 'input-streaming',
        input: { expected_answer: ANSWER },
        rawInput: `{"expected_answer":"${ANSWER}"`,
      },
    ],
  } as unknown as QuizUIMessage;

  it("cuts a student's stored parts: complete, refused, and still streaming when the turn ended", () => {
    const copy = structuredClone(storedOffers);
    const stored = projectMessage(storedOffers, quizVisibility)!;
    expect(stored.parts).toEqual([
      {
        type: 'tool-offer_next_step',
        toolCallId: 'o1',
        state: 'output-available',
        input: offerShown,
        output: offerOutput,
      },
      {
        type: 'dynamic-tool',
        toolName: 'offer_next_step',
        toolCallId: 'o2',
        state: 'output-error',
        input: { ...offerShown, actions: ['try_again'] },
        errorText: 'Invalid input',
      },
      {
        type: 'tool-offer_next_step',
        toolCallId: 'o3',
        state: 'input-streaming',
        input: undefined,
      },
    ]);
    expectNoAnswer(stored);
    expectNoAnswer(projectTranscript([storedOffers], quizVisibility));
    expect(storedOffers).toEqual(copy);
  });

  it('keeps the answer for staff, and still cuts the code quote', () => {
    const withQuote = {
      ...storedOffers,
      parts: [
        ...storedOffers.parts.slice(0, 2),
        {
          type: 'tool-present_question',
          toolCallId: 'c1',
          state: 'output-available',
          input: quotedInput,
          output: quotedOutput,
        },
      ],
    } as unknown as QuizUIMessage;
    const staff = projectTranscript([withQuote], quizStaffVisibility);
    expect(staff[0].parts[0]).toEqual(storedOffers.parts[0]);
    expect(JSON.stringify(staff)).toContain(ANSWER);
    expectNoQuote(staff);
  });
});

describe('toolVisibility', () => {
  it('reads the registry and defaults to hidden', () => {
    expect(toolVisibility(quizVisibility, 'present_question')).toBe('shown');
    expect(toolVisibility(quizVisibility, 'explore_codebase')).toBe('label');
    expect(toolVisibility(quizVisibility, 'content_get')).toBe('label');
    expect(toolVisibility(quizVisibility, 'content_search')).toBe('label');
    expect(toolVisibility(quizVisibility, 'record_question_result')).toBe('hidden');
    expect(toolVisibility(quizVisibility, 'toString')).toBe('hidden');
    expect(toolVisibility(quizVisibility, 'unknown')).toBe('hidden');
  });
});

// A recorded turn: what the loop's full stream holds (persisted), and what the
// projector lets through (live).
const TURN: Chunk[] = [
  { type: 'start', messageId: 'a1' },
  { type: 'start-step' },
  { type: 'reasoning-start', id: 'r1' },
  { type: 'reasoning-delta', id: 'r1', delta: '' },
  { type: 'reasoning-end', id: 'r1', providerMetadata: { anthropic: { signature: 'sig-1' } } },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Right: the child combinator ' },
  { type: 'text-delta', id: 't1', delta: 'matches direct children.' },
  { type: 'text-end', id: 't1' },
  { type: 'tool-input-start', toolCallId: 'c1', toolName: 'record_question_result' },
  { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"question_num":1}' },
  {
    type: 'tool-input-available',
    toolCallId: 'c1',
    toolName: 'record_question_result',
    input: {
      question_num: 1,
      answers: [{ level: 'correct', hints_before: 0 }],
      brief_feedback: 'Nailed it',
    },
  },
  {
    type: 'tool-output-available',
    toolCallId: 'c1',
    output: { question_num: 1, emoji: 'rocket', brief_feedback: 'Nailed it' },
  },
  {
    type: 'data-question-result',
    id: 'qr1',
    data: { question_num: 1, emoji: 'rocket', brief_feedback: 'Nailed it', credit_earned: 100 },
  },
  { type: 'finish-step' },
  { type: 'start-step' },
  { type: 'tool-input-start', toolCallId: 'c2', toolName: 'explore_codebase' },
  {
    type: 'tool-input-available',
    toolCallId: 'c2',
    toolName: 'explore_codebase',
    input: { focus_area: 'navigation', specific_question: 'how are links styled?' },
  },
  {
    type: 'data-step',
    id: 'st1',
    data: { kind: 'read_file', path: 'styles/nav.css', focus_area: 'navigation' },
  },
  { type: 'data-foo', id: 'f1', data: { anything: true } },
  { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
  {
    type: 'tool-output-available',
    toolCallId: 'c2',
    output: { excerpts: '1| nav > a {}', files_read: ['styles/nav.css'] },
  },
  { type: 'finish-step' },
  { type: 'start-step' },
  {
    type: 'tool-input-error',
    toolCallId: 'c3',
    toolName: 'present_question',
    input: { question_number: 'two', code_quote: quote },
    errorText: 'Invalid input',
    dynamic: true,
  },
  { type: 'tool-input-start', toolCallId: 'c4', toolName: 'present_question' },
  { type: 'tool-input-delta', toolCallId: 'c4', inputTextDelta: JSON.stringify(quotedInput) },
  {
    type: 'tool-input-available',
    toolCallId: 'c4',
    toolName: 'present_question',
    input: quotedInput,
  },
  { type: 'tool-output-available', toolCallId: 'c4', output: quotedOutput },
  { type: 'tool-input-start', toolCallId: 'c5', toolName: 'mcp_tool', dynamic: true },
  {
    type: 'tool-input-available',
    toolCallId: 'c5',
    toolName: 'mcp_tool',
    input: { q: 'x' },
    dynamic: true,
  },
  { type: 'tool-output-available', toolCallId: 'c5', output: { r: 1 }, dynamic: true },
  { type: 'finish-step' },
  { type: 'start-step' },
  { type: 'tool-input-start', toolCallId: 'c6', toolName: 'offer_next_step' },
  ...offerDeltas('c6'),
  {
    type: 'tool-input-available',
    toolCallId: 'c6',
    toolName: 'offer_next_step',
    input: offerInput,
  },
  { type: 'tool-output-available', toolCallId: 'c6', output: offerOutput },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'tool-calls' },
];

async function rebuild(chunks: Chunk[]): Promise<UIMessage> {
  const stream = new ReadableStream<Chunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream })) last = m;
  if (!last) throw new Error('no message');
  return structuredClone(last);
}

describe('live equals stored', () => {
  it('the message rebuilt from projected chunks equals projectMessage of the persisted message', async () => {
    const persisted = await rebuild(TURN);
    const live = await rebuild(project(TURN));
    const stored = projectMessage(persisted, quizVisibility);
    expect(stored).toEqual(live);
  });

  it('the persisted message keeps what the viewer never sees', async () => {
    const persisted = await rebuild(TURN);
    const types = persisted.parts.map(p => p.type);
    expect(types).toContain('reasoning');
    expect(types).toContain('tool-record_question_result');
    expect(types).toContain('tool-explore_codebase');
    expect(types).toContain('data-foo');
    expect(JSON.stringify(persisted)).toContain('code_quote');
    expect(JSON.stringify(persisted)).toContain(ANSWER);
  });

  it('the viewer copy has no reasoning, hidden or label tools, or undeclared data', async () => {
    const stored = projectMessage(await rebuild(TURN), quizVisibility)!;
    const types = stored.parts.map(p => p.type);
    expect(types).not.toContain('reasoning');
    expect(types).not.toContain('tool-record_question_result');
    expect(types).not.toContain('tool-explore_codebase');
    expect(types).not.toContain('data-foo');
    expect(types).not.toContain('source-url');
    expect(types).toEqual([
      'step-start',
      'text',
      'data-question-result',
      'step-start',
      'data-step',
      'step-start',
      'dynamic-tool',
      'tool-present_question',
      'step-start',
      'tool-offer_next_step',
    ]);
    expectNoQuote(stored);
    expectNoAnswer(stored);
    expectNoAnswer(project(TURN));
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('navigation');
    expect(serialized).not.toContain('sig-1');
    expect(serialized).not.toContain('hints_before');
    expect(serialized).not.toContain('credit_earned');
  });
});

describe('projectMessage', () => {
  const userRow: QuizUIMessage = {
    id: 'u1',
    role: 'user',
    metadata: { hiddenPartIndexes: [1], action: 'next' },
    parts: [
      { type: 'text', text: 'next' },
      { type: 'text', text: 'CURRENT STATUS ...' },
    ],
  };

  it('removes hidden parts and the index list, keeping the action tag', () => {
    expect(projectMessage(userRow, quizVisibility)).toEqual({
      id: 'u1',
      role: 'user',
      metadata: { action: 'next' },
      parts: [{ type: 'text', text: 'next' }],
    });
  });

  it('returns null for a hidden message', () => {
    expect(
      projectMessage(
        {
          id: 'o1',
          role: 'user',
          metadata: { hidden: true },
          parts: [{ type: 'text', text: 'Begin.' }],
        },
        quizVisibility
      )
    ).toBeNull();
  });

  it('returns null for a system message', () => {
    expect(
      projectMessage(
        { id: 's', role: 'system', parts: [{ type: 'text', text: 'x' }] },
        quizVisibility
      )
    ).toBeNull();
  });

  it('keeps a message whose parts are all dropped, for its id', () => {
    const m: UIMessage = { id: 'a2', role: 'assistant', parts: [{ type: 'reasoning', text: '' }] };
    expect(projectMessage(m, quizVisibility)).toEqual({ id: 'a2', role: 'assistant', parts: [] });
  });

  it('does not modify the input', () => {
    const copy = structuredClone(userRow);
    projectMessage(userRow, quizVisibility);
    expect(userRow).toEqual(copy);
  });

  it('projectTranscript drops hidden messages and projects the rest in order', () => {
    const t = projectTranscript(
      [
        {
          id: 'o1',
          role: 'user',
          metadata: { hidden: true },
          parts: [{ type: 'text', text: 'Begin.' }],
        },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Hello' },
            { type: 'reasoning', text: '' },
          ],
        },
        userRow,
      ] as QuizUIMessage[],
      quizVisibility
    );
    expect(t.map(m => m.id)).toEqual(['a1', 'u1']);
    expect(t[0].parts).toEqual([{ type: 'text', text: 'Hello' }]);
  });
});
