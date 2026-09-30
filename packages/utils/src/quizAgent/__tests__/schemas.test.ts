import { asSchema, type FlexibleSchema } from 'ai';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BUTTON_TEXT,
  NEXT_STEP_LEAD_IN,
  nextStepLeadIn,
  OfferNextStepOutputSchema,
  CodeAwareQuizQuestionSchema,
  CodeQuoteSchema,
  ExploreCodebaseSchema,
  OfferNextStepPartSchema,
  OfferNextStepSchema,
  PresentQuestionOutputSchema,
  QuestionCardSchema,
  QUIZ_TOOL_ORDER,
  QuizEvaluationFeedbackSchema,
  QuizEvaluationRecordV2Schema,
  QuizQuestionSchema,
  RecordQuestionResultSchema,
  StoredQuestionResultSchema,
  TOOL_DESCRIPTIONS,
  quizToolDefs,
  quizStaffVisibility,
  quizVisibility,
  type QuizUIMessage,
} from '../index.ts';

const card = {
  preamble: 'Let me ask about your layout.',
  question_number: 1,
  total_questions: 8,
  question_text: 'Why does the header stay on top?',
};

const feedback = {
  final_acknowledgment: 'Good work.',
  quiz_complete: true as const,
  evaluation: 'GOOD',
  numeric_score: 3,
  feedback_summary: 'Solid understanding.',
  feedback_strengths: ['flexbox'],
  feedback_improvements: ['specificity'],
  feedback_recommendation: 'Practice selectors.',
  feedback_effort_note: 'Persistent.',
};

describe('RecordQuestionResultSchema', () => {
  const ok = {
    question_num: 2,
    answers: [
      { level: 'partly_right', hints_before: 0 },
      { level: 'correct', hints_before: 1 },
    ],
    brief_feedback: 'Got there with one hint',
  };

  it('accepts answers with non-decreasing hints', () => {
    expect(RecordQuestionResultSchema.safeParse(ok).success).toBe(true);
  });

  it('accepts an empty answer list (skipped)', () => {
    expect(RecordQuestionResultSchema.safeParse({ ...ok, answers: [] }).success).toBe(true);
  });

  it('refuses decreasing hints_before', () => {
    const r = RecordQuestionResultSchema.safeParse({
      ...ok,
      answers: [
        { level: 'minimal', hints_before: 2 },
        { level: 'correct', hints_before: 1 },
      ],
    });
    expect(r.success).toBe(false);
  });

  it.each([
    ['a negative hint count', { answers: [{ level: 'correct', hints_before: -1 }] }],
    ['a fractional hint count', { answers: [{ level: 'correct', hints_before: 0.5 }] }],
    ['an unknown level', { answers: [{ level: 'perfect', hints_before: 0 }] }],
    ['question 0', { question_num: 0 }],
    ['empty feedback', { brief_feedback: '' }],
    ['feedback over 100 characters', { brief_feedback: 'x'.repeat(101) }],
    ['a model-chosen credit field in place of answers', { answers: undefined, credit_earned: 100 }],
  ])('refuses %s', (_label, patch) => {
    expect(RecordQuestionResultSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
});

describe('OfferNextStepSchema', () => {
  const expected_answer = '`map` returns a new array and leaves the original alone.';
  const feedback = 'Right idea: `map` returns a new array. The original is left alone.';

  it.each([[['next']], [['try_again']], [['try_again', 'next']]])('accepts %j', actions => {
    expect(OfferNextStepSchema.safeParse({ expected_answer, feedback, actions }).success).toBe(
      true
    );
  });

  it.each([[[]], [['next', 'next']], [['next', 'try_again', 'next']], [['skip']]])(
    'refuses %j',
    actions => {
      expect(OfferNextStepSchema.safeParse({ expected_answer, feedback, actions }).success).toBe(
        false
      );
    }
  );

  it('requires feedback from the model: present, a string, not blank', () => {
    for (const bad of [{}, { feedback: '' }, { feedback: '  \n ' }, { feedback: 3 }]) {
      expect(
        OfferNextStepSchema.safeParse({ expected_answer, ...bad, actions: ['next'] }).success
      ).toBe(false);
    }
    expect(
      OfferNextStepSchema.parse({ expected_answer, feedback: `  ${feedback}\n`, actions: ['next'] })
    ).toEqual({ expected_answer, feedback, actions: ['next'] });
  });

  it('requires the expected answer from the model: present, a string, not blank', () => {
    for (const bad of [
      {},
      { expected_answer: '' },
      { expected_answer: ' \n' },
      { expected_answer: 3 },
    ]) {
      expect(OfferNextStepSchema.safeParse({ ...bad, feedback, actions: ['next'] }).success).toBe(
        false
      );
    }
    expect(
      OfferNextStepSchema.parse({
        expected_answer: ` ${expected_answer}\n`,
        feedback,
        actions: ['next'],
      })
    ).toEqual({ expected_answer, feedback, actions: ['next'] });
  });

  it('puts the expected answer first, then feedback, all required, in the JSON schema the model reads', async () => {
    const json = (await asSchema(OfferNextStepSchema as FlexibleSchema<unknown>).jsonSchema) as {
      properties: Record<string, { minLength?: number; description?: string }>;
      required: string[];
    };
    expect(Object.keys(json.properties)).toEqual(['expected_answer', 'feedback', 'actions']);
    expect(json.required).toEqual(
      expect.arrayContaining(['expected_answer', 'feedback', 'actions'])
    );
    expect(json.properties.expected_answer.minLength).toBe(1);
    expect(json.properties.expected_answer.description).toBe(
      'The correct answer to this question in one or two sentences, for staff only; never shown to the student.'
    );
    expect(json.properties.feedback.minLength).toBe(1);
    expect(json.properties.feedback.description).toBe(
      "2 to 4 sentences on the student's answer: what is right, what is wrong, and why. When offering Try again, never state or hint at the content of expected_answer (no correct values, results, names or properties it contains) and give no direction toward it: no 'check...', 'look at...', 'think about...' or leading questions. Name only what is wrong in their reasoning. Example: not 'your white text turns black on hover' or 'check which selector is more specific', but 'file order isn't what decides this here.'"
    );
    // Feedback gives no pointer toward the answer: guidance is a hint's (Tim's decision).
    expect(json.properties.feedback.description).not.toMatch(/where to look|look instead/);
  });

  it('says in offer_next_step that feedback gives no direction toward the answer', () => {
    expect(TOOL_DESCRIPTIONS.offer_next_step).toContain(
      'The feedback says what is right, what is wrong and why; with Try again offered it gives no direction toward the answer, since guidance comes only as a hint after a Try again click.'
    );
  });

  it('keeps stored parts without feedback or an expected answer valid, for the UI types and old rows', () => {
    expect(OfferNextStepPartSchema.safeParse({ actions: ['next'] }).success).toBe(true);
    expect(OfferNextStepPartSchema.safeParse({ feedback, actions: ['next'] }).success).toBe(true);
    expect(OfferNextStepPartSchema.parse({ expected_answer, feedback, actions: ['next'] })).toEqual(
      { expected_answer, feedback, actions: ['next'] }
    );
    expect(quizToolDefs.offer_next_step.inputSchema).toBe(OfferNextStepPartSchema);
  });

  it('hides the expected answer from every student, and only from them', () => {
    expect(quizVisibility.hiddenInputKeys.offer_next_step).toEqual(['expected_answer']);
    expect(quizStaffVisibility.hiddenInputKeys).not.toHaveProperty('offer_next_step');
    expect(quizStaffVisibility.hiddenInputKeys.present_question).toEqual(
      quizVisibility.hiddenInputKeys.present_question
    );
    expect(quizStaffVisibility.tools).toEqual(quizVisibility.tools);
    expect(quizStaffVisibility.dataParts).toBe(quizVisibility.dataParts);
  });
});

describe('the lead-in shown with the buttons', () => {
  it('uses the previous wording', () => {
    expect(NEXT_STEP_LEAD_IN).toEqual({
      next: 'Ready for the next question?',
      results: 'Ready to see your results?',
      try_again_or_next: 'Would you like to try again or move on?',
    });
  });

  it('picks it from the buttons and whether the question is the last one', () => {
    expect(nextStepLeadIn(['next'], false)).toBe('Ready for the next question?');
    expect(nextStepLeadIn(['next'], true)).toBe('Ready to see your results?');
    expect(nextStepLeadIn(['try_again', 'next'], false)).toBe(
      'Would you like to try again or move on?'
    );
    expect(nextStepLeadIn(['next', 'try_again'], true)).toBe(
      'Would you like to try again or move on?'
    );
    expect(nextStepLeadIn(['try_again'], false)).toBeNull();
  });

  it('is part of the output, not the input', () => {
    expect(
      OfferNextStepOutputSchema.parse({
        actions: ['next'],
        lead_in: 'Ready for the next question?',
      })
    ).toEqual({ actions: ['next'], lead_in: 'Ready for the next question?' });
    expect(OfferNextStepOutputSchema.safeParse({ actions: ['next'] }).success).toBe(false);
    expect(quizToolDefs.offer_next_step.outputSchema).toBe(OfferNextStepOutputSchema);
    expect(
      OfferNextStepSchema.parse({
        expected_answer: 'Yes.',
        feedback: 'Yes.',
        actions: ['next'],
        lead_in: 'x',
      })
    ).toEqual({ expected_answer: 'Yes.', feedback: 'Yes.', actions: ['next'] });
    // The feedback stays in the input; the output never echoes it.
    expect(
      OfferNextStepOutputSchema.parse({ feedback: 'Yes.', actions: ['next'], lead_in: 'x' })
    ).toEqual({ actions: ['next'], lead_in: 'x' });
  });
});

describe('QuizQuestionSchema', () => {
  it('accepts a card', () => {
    expect(QuizQuestionSchema.safeParse(card).success).toBe(true);
  });

  it.each([
    ['question 0', { question_number: 0 }],
    ['an empty question text', { question_text: '' }],
    ['a total of 0', { total_questions: 0 }],
  ])('refuses %s', (_label, patch) => {
    expect(QuizQuestionSchema.safeParse({ ...card, ...patch }).success).toBe(false);
  });

  it('has no code_quote: a standard attempt never sees one', () => {
    expect(Object.keys(QuizQuestionSchema.shape)).not.toContain('code_quote');
  });
});

describe('code quotes', () => {
  const quote = { path: 'css/style.css', ranges: [[11, 15]], anchor: '.features {' };

  it('accepts a quote with ranges, omitted lines and one edit', () => {
    expect(
      CodeQuoteSchema.safeParse({
        ...quote,
        ranges: [
          [1, 2],
          [11, 15],
        ],
        omit: [13],
        edit: { line: 12, replace: 'display: block;' },
      }).success
    ).toBe(true);
  });

  it.each([
    ['no ranges', { ranges: [] }],
    ['a range of one number', { ranges: [[11]] }],
    ['a range of three numbers', { ranges: [[11, 12, 13]] }],
    ['line 0', { ranges: [[0, 4]] }],
    ['a fractional line', { ranges: [[1.5, 4]] }],
    ['an empty anchor', { anchor: '' }],
    ['an empty path', { path: '' }],
    [
      'more than eight ranges',
      { ranges: Array.from({ length: 9 }, (_, i) => [i * 2 + 1, i * 2 + 1]) },
    ],
  ])('refuses %s', (_label, patch) => {
    expect(CodeQuoteSchema.safeParse({ ...quote, ...patch }).success).toBe(false);
  });

  it('allows typed code only when the file cannot be read twice, copied from the exploration', () => {
    const copied = 'copied exactly from your exploration output without their "N| " prefixes';
    const named = 'with the file and the rule or element named in context';
    const snippet = CodeAwareQuizQuestionSchema.shape.code_snippet.description ?? '';
    const quoted = CodeAwareQuizQuestionSchema.shape.code_quote.description ?? '';
    for (const text of [snippet, quoted]) {
      expect(text).toContain('fails twice because the file cannot be read');
      expect(text).toContain(copied);
      expect(text).toContain(named);
    }
    expect(snippet).toContain("In a code-aware quiz never the student's code: use code_quote.");
  });

  it('is an optional field of the code-aware question', () => {
    expect(CodeAwareQuizQuestionSchema.safeParse(card).success).toBe(true);
    expect(CodeAwareQuizQuestionSchema.parse({ ...card, code_quote: quote }).code_quote).toEqual(
      quote
    );
  });

  it('writes each range as an array of two line numbers in the JSON schema, never a tuple', async () => {
    const schema = (await asSchema(CodeAwareQuizQuestionSchema).jsonSchema) as {
      properties: {
        code_quote: {
          properties: { ranges: { items: { items: unknown; minItems: number; maxItems: number } } };
        };
      };
    };
    const range = schema.properties.code_quote.properties.ranges.items;
    expect(Array.isArray(range.items)).toBe(false);
    expect(range.items).toMatchObject({ type: 'integer', minimum: 1 });
    expect(range).toMatchObject({ minItems: 2, maxItems: 2 });
  });

  it('stores the card with its source, and a card without one as before', () => {
    const source = { path: 'css/style.css', lines: '11-15', changed: false };
    expect(QuestionCardSchema.parse({ ...card, source }).source).toEqual(source);
    expect(QuestionCardSchema.parse(card)).toEqual(card);
    expect(
      PresentQuestionOutputSchema.parse({
        card: { ...card, source },
        question_number: 1,
        total_questions: 8,
      }).card.source
    ).toEqual(source);
    // The quote itself is never part of the stored card.
    expect(QuestionCardSchema.parse({ ...card, code_quote: quote })).not.toHaveProperty(
      'code_quote'
    );
  });
});

describe('ExploreCodebaseSchema', () => {
  const purpose = 'prepare_next' as const;

  it('defaults depth to focused', () => {
    expect(ExploreCodebaseSchema.parse({ purpose, focus_area: 'initial' }).depth).toBe('focused');
  });

  it('requires a purpose of check_current or prepare_next', () => {
    expect(ExploreCodebaseSchema.safeParse({ focus_area: 'api' }).success).toBe(false);
    expect(ExploreCodebaseSchema.safeParse({ purpose: 'other', focus_area: 'api' }).success).toBe(
      false
    );
    for (const p of ['check_current', 'prepare_next']) {
      expect(ExploreCodebaseSchema.parse({ purpose: p, focus_area: 'api' }).purpose).toBe(p);
    }
  });

  it('refuses an overlong focus area and question', () => {
    expect(ExploreCodebaseSchema.safeParse({ purpose, focus_area: 'x'.repeat(201) }).success).toBe(
      false
    );
    expect(
      ExploreCodebaseSchema.safeParse({
        purpose,
        focus_area: 'api',
        specific_question: 'x'.repeat(501),
      }).success
    ).toBe(false);
  });

  it('has no previousFindings or avoidFiles input', () => {
    const parsed = ExploreCodebaseSchema.parse({
      purpose,
      focus_area: 'api',
      previousFindings: ['a'],
      avoidFiles: ['b'],
    });
    expect(parsed).not.toHaveProperty('previousFindings');
    expect(parsed).not.toHaveProperty('avoidFiles');
  });
});

describe('QuizEvaluationFeedbackSchema', () => {
  it('accepts feedback text', () => {
    expect(QuizEvaluationFeedbackSchema.safeParse(feedback).success).toBe(true);
  });

  it('takes the band as optional and never refuses it: the server sets it', () => {
    const { evaluation: _e, numeric_score: _n, ...rest } = feedback;
    expect(QuizEvaluationFeedbackSchema.safeParse(rest).success).toBe(true);
    expect(
      QuizEvaluationFeedbackSchema.safeParse({ ...feedback, evaluation: 'GREAT', numeric_score: 9 })
        .success
    ).toBe(true);
  });

  it('asks for the closing words in final_acknowledgment, shown above the results', () => {
    expect(QuizEvaluationFeedbackSchema.shape.final_acknowledgment.description).toMatch(
      /shown above the results/
    );
    expect(
      QuizEvaluationFeedbackSchema.safeParse({ ...feedback, final_acknowledgment: '' }).success
    ).toBe(false);
  });

  it('refuses quiz_complete other than true', () => {
    expect(
      QuizEvaluationFeedbackSchema.safeParse({ ...feedback, quiz_complete: false }).success
    ).toBe(false);
  });

  it('takes ended_early as an optional flag, described for the confirmed early end', () => {
    expect(QuizEvaluationFeedbackSchema.safeParse(feedback).success).toBe(true);
    expect(QuizEvaluationFeedbackSchema.parse({ ...feedback, ended_early: true }).ended_early).toBe(
      true
    );
    expect(
      QuizEvaluationFeedbackSchema.safeParse({ ...feedback, ended_early: 'yes' }).success
    ).toBe(false);
    expect(QuizEvaluationFeedbackSchema.shape.ended_early.description).toMatch(
      /confirmed ending the quiz early/
    );
  });
});

describe('records', () => {
  const stored = {
    question_num: 1,
    attempts: 1,
    tries: 1,
    eventually_correct: true,
    first_attempt_correct: true,
    credit_earned: 100,
    emoji: 'rocket',
    brief_feedback: 'Nailed it',
    recorded_at: '2026-09-30T04:00:00.000Z',
  };

  it('stores a question result with legacy and new keys', () => {
    expect(StoredQuestionResultSchema.parse(stored)).toEqual(stored);
  });

  it('marks a question the server recorded as skipped for an early end', () => {
    const skipped = {
      ...stored,
      attempts: 0,
      tries: 0,
      eventually_correct: false,
      first_attempt_correct: false,
      credit_earned: 0,
      brief_feedback: '',
      skipped_by_end: true,
    };
    expect(StoredQuestionResultSchema.parse(skipped)).toEqual(skipped);
    expect(StoredQuestionResultSchema.safeParse({ ...stored, skipped_by_end: false }).success).toBe(
      false
    );
  });

  it('accepts a server-completed evaluation without feedback and keeps emoji', () => {
    const { recorded_at: _r, ...entry } = stored;
    const record = {
      v: 2,
      source: 'server',
      partial_credit_percentage: 100,
      first_attempt_percentage: 100,
      question_results: [entry],
    };
    expect(QuizEvaluationRecordV2Schema.parse(record)).toEqual(record);
  });

  it('keeps model feedback without quiz_complete or ended_early', () => {
    const { quiz_complete: _q, ...text } = feedback;
    const parsed = QuizEvaluationRecordV2Schema.parse({
      v: 2,
      source: 'model',
      feedback: { ...feedback, ended_early: true },
      partial_credit_percentage: 0,
      first_attempt_percentage: 0,
      question_results: [],
    });
    expect(parsed.feedback).toEqual(text);
  });

  it('carries the server band on the record, and reads a record stored without it', () => {
    const base = {
      v: 2,
      source: 'server',
      partial_credit_percentage: 72,
      first_attempt_percentage: 0,
      question_results: [],
    };
    expect(
      QuizEvaluationRecordV2Schema.parse({ ...base, evaluation: 'GOOD', numeric_score: 3 })
    ).toMatchObject({ evaluation: 'GOOD', numeric_score: 3 });
    expect(QuizEvaluationRecordV2Schema.parse(base)).toEqual(base);
    expect(
      QuizEvaluationRecordV2Schema.safeParse({ ...base, evaluation: 'GREAT', numeric_score: 3 })
        .success
    ).toBe(false);
  });

  it('refuses another record version', () => {
    expect(
      QuizEvaluationRecordV2Schema.safeParse({
        v: 1,
        source: 'model',
        partial_credit_percentage: 0,
        first_attempt_percentage: 0,
        question_results: [],
      }).success
    ).toBe(false);
  });
});

describe('quizToolDefs', () => {
  it('lists the fixed tool set in order, without executes', () => {
    expect(Object.keys(quizToolDefs)).toEqual([...QUIZ_TOOL_ORDER]);
    for (const def of Object.values(quizToolDefs)) {
      expect(def).not.toHaveProperty('execute');
      expect(def.outputSchema).toBeDefined();
      expect(typeof def.description).toBe('string');
    }
  });

  it('takes each description from TOOL_DESCRIPTIONS, which has one per tool', () => {
    expect(Object.keys(TOOL_DESCRIPTIONS)).toEqual([...QUIZ_TOOL_ORDER]);
    for (const name of QUIZ_TOOL_ORDER) {
      expect(quizToolDefs[name].description).toBe(TOOL_DESCRIPTIONS[name]);
    }
  });

  it('names the exact button texts in offer_next_step', () => {
    expect(TOOL_DESCRIPTIONS.offer_next_step).toContain(
      `"${BUTTON_TEXT.try_again}" or "${BUTTON_TEXT.next}"`
    );
  });

  it('every tool has a visibility entry', () => {
    expect(Object.keys(quizVisibility.tools).sort()).toEqual([...QUIZ_TOOL_ORDER].sort());
  });

  it.each(Object.entries(quizToolDefs))(
    '%s input converts to an object JSON schema',
    async (_n, def) => {
      const schema = await asSchema(def.inputSchema as FlexibleSchema<unknown>).jsonSchema;
      expect(schema).toMatchObject({ type: 'object' });
    }
  );

  it('record_question_result input names answers with a level enum and a hint count', async () => {
    const schema = (await asSchema(quizToolDefs.record_question_result.inputSchema).jsonSchema) as {
      properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'answers',
      'brief_feedback',
      'question_num',
      'student_asked_to_move_on',
    ]);
    expect(Object.keys(schema.properties.answers.items?.properties ?? {}).sort()).toEqual([
      'hints_before',
      'level',
    ]);
  });

  it('describes student_asked_to_move_on for this question only, not for ending the quiz', () => {
    const text = RecordQuestionResultSchema.shape.student_asked_to_move_on.description ?? '';
    expect(text).toContain('asks to skip this question or move on.');
    expect(text).not.toMatch(/end the quiz/);
  });

  it('takes student_asked_to_move_on as an optional flag the service can ignore', () => {
    const base = {
      question_num: 2,
      answers: [],
      brief_feedback: 'Moved on',
    };
    expect(RecordQuestionResultSchema.safeParse(base).success).toBe(true);
    expect(
      RecordQuestionResultSchema.safeParse({ ...base, student_asked_to_move_on: true }).success
    ).toBe(true);
    expect(
      RecordQuestionResultSchema.safeParse({ ...base, student_asked_to_move_on: 'yes' }).success
    ).toBe(false);
  });

  it('types tool parts from the schemas', () => {
    type Part = QuizUIMessage['parts'][number];
    type PresentPart = Extract<Part, { type: 'tool-present_question'; state: 'output-available' }>;
    expectTypeOf<PresentPart['output']['card']['question_text']>().toEqualTypeOf<string>();
    expectTypeOf<PresentPart['output']['card']['source']>().toEqualTypeOf<
      { path: string; lines: string; changed: boolean } | undefined
    >();
    type NextPart = Extract<Part, { type: 'tool-offer_next_step'; state: 'output-available' }>;
    expectTypeOf<NextPart['output']['actions']>().toEqualTypeOf<('next' | 'try_again')[]>();
    expectTypeOf<NextPart['output']['lead_in']>().toEqualTypeOf<string>();
    expectTypeOf<NextPart['input']['feedback']>().toEqualTypeOf<string | undefined>();
  });
});

describe('BUTTON_TEXT', () => {
  it('matches the legacy button messages', () => {
    expect(BUTTON_TEXT).toEqual({
      try_again: "I'd like to try answering this question again",
      next: 'next',
    });
  });
});
