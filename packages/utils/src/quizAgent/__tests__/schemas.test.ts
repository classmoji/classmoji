import { asSchema, type FlexibleSchema } from 'ai';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BUTTON_TEXT,
  ExploreCodebaseSchema,
  OfferNextStepSchema,
  QUIZ_TOOL_ORDER,
  QuizEvaluationFeedbackSchema,
  QuizEvaluationRecordV2Schema,
  QuizQuestionSchema,
  RecordQuestionResultSchema,
  StoredQuestionResultSchema,
  quizToolDefs,
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
  it.each([[['next']], [['try_again']], [['try_again', 'next']]])('accepts %j', actions => {
    expect(OfferNextStepSchema.safeParse({ actions }).success).toBe(true);
  });

  it.each([[[]], [['next', 'next']], [['next', 'try_again', 'next']], [['skip']]])(
    'refuses %j',
    actions => {
      expect(OfferNextStepSchema.safeParse({ actions }).success).toBe(false);
    }
  );
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

  it('refuses quiz_complete other than true', () => {
    expect(
      QuizEvaluationFeedbackSchema.safeParse({ ...feedback, quiz_complete: false }).success
    ).toBe(false);
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

  it('keeps model feedback without quiz_complete', () => {
    const { quiz_complete: _q, ...text } = feedback;
    const parsed = QuizEvaluationRecordV2Schema.parse({
      v: 2,
      source: 'model',
      feedback,
      partial_credit_percentage: 0,
      first_attempt_percentage: 0,
      question_results: [],
    });
    expect(parsed.feedback).toEqual(text);
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
    ]);
    expect(Object.keys(schema.properties.answers.items?.properties ?? {}).sort()).toEqual([
      'hints_before',
      'level',
    ]);
  });

  it('types tool parts from the schemas', () => {
    type Part = QuizUIMessage['parts'][number];
    type PresentPart = Extract<Part, { type: 'tool-present_question'; state: 'output-available' }>;
    expectTypeOf<PresentPart['output']['card']['question_text']>().toEqualTypeOf<string>();
    type NextPart = Extract<Part, { type: 'tool-offer_next_step'; state: 'output-available' }>;
    expectTypeOf<NextPart['output']['actions']>().toEqualTypeOf<('next' | 'try_again')[]>();
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
