import { describe, expect, it } from 'vitest';
import { BUTTON_TEXT } from '@classmoji/utils/quiz-agent';
import {
  baseSystemPrompt,
  buildQuizPrompt,
  codeAwareAgentPrompt,
  evaluationNotice,
  type QuizPromptInput,
} from '../index.ts';

const base: QuizPromptInput = {
  quizSystemPrompt: null,
  rubricPrompt: null,
  questionCount: 8,
  subject: 'HTML & CSS',
  difficultyLevel: 'Beginner',
  isCodeAware: false,
  sourceMaterial: null,
  classroomRef: null,
};

const standard = buildQuizPrompt(base);
const codeAware = buildQuizPrompt({ ...base, isCodeAware: true });
const bothModes = [
  ['standard', standard],
  ['code-aware', codeAware],
] as const;

describe('quiz prompt: typed tools only', () => {
  it.each(bothModes)('%s: carries no text markers or button tokens', (_label, prompt) => {
    const text = `${prompt.staticPrompt}\n${prompt.dynamicPrompt}`;
    expect(text).not.toContain('[QUESTION_CARD]');
    expect(text).not.toContain('[BUTTON:');
    expect(text).not.toContain('[QUESTION_COMPLETE]');
    expect(text).not.toContain('[QUIZ_EVALUATION]');
  });

  it.each(bothModes)('%s: states no credit scale, score or percentage', (_label, prompt) => {
    const text = `${prompt.staticPrompt}\n${prompt.dynamicPrompt}`;
    expect(text).not.toMatch(/\d+\s*%/);
    expect(text).not.toMatch(/credit[_ ]scale/i);
    expect(text).not.toContain('credit_earned');
    expect(text).not.toMatch(/\battempts\s*:/);
    expect(text).not.toMatch(/Mark as/i);
    expect(text).not.toMatch(/Current score:|you've earned|points out of/i);
    // The hint cost lives in one server constant; the model never sees it.
    expect(text).not.toMatch(/\b15\b/);
    // "Give me a hint" used to be free; it is a counted hint now.
    expect(text).not.toMatch(/"Give me a hint" = NOT/);
  });

  it.each(bothModes)('%s: names no file tool other than explore_codebase', (_label, prompt) => {
    const text = `${prompt.staticPrompt}\n${prompt.dynamicPrompt}`;
    expect(text).not.toMatch(/secure_(read|grep|glob)/);
    expect(text).not.toContain('CODE ACCESS');
  });

  it.each(bothModes)('%s: names every quiz tool', (_label, prompt) => {
    for (const name of [
      'present_question',
      'record_question_result',
      'offer_next_step',
      'submit_quiz_evaluation',
    ]) {
      expect(prompt.staticPrompt).toContain(name);
    }
  });

  it('names explore_codebase only in code-aware mode', () => {
    expect(codeAware.staticPrompt).toContain('explore_codebase');
    expect(standard.staticPrompt).not.toContain('explore_codebase');
  });

  it('teaches the five answer levels and the hint count', () => {
    for (const level of ['correct', 'mostly_right', 'partly_right', 'minimal', 'no_attempt']) {
      expect(baseSystemPrompt).toContain(`- ${level}:`);
    }
    expect(baseSystemPrompt).toContain('hints_before');
    expect(baseSystemPrompt).toMatch(/cumulative/);
  });

  it('keeps clarifications free and counts every hint, including one before an answer', () => {
    expect(baseSystemPrompt).toMatch(
      /clarifying question about the\s+wording: NOT an answer and NOT a hint/
    );
    expect(baseSystemPrompt).toMatch(
      /It counts as a hint, even when the student has not answered yet/
    );
    expect(baseSystemPrompt).toMatch(/exactly ONE\s+hint/);
  });

  it('keeps guidance out of answer feedback and ends the question at the reveal', () => {
    expect(baseSystemPrompt).toMatch(
      /Feedback on an answer says only what is right and what is wrong/
    );
    expect(baseSystemPrompt).toMatch(/rate no answer given after it/);
  });

  it('names the exact texts the two buttons send', () => {
    const flat = baseSystemPrompt.replace(/\s+/g, ' ');
    expect(flat).toContain(`Try again sends "${BUTTON_TEXT.try_again}"`);
    expect(flat).toContain(`Next sends "${BUTTON_TEXT.next}"`);
  });

  it('says near the top that every word of text reaches the student', () => {
    const at = baseSystemPrompt.indexOf('EVERY WORD YOU WRITE IS SHOWN TO THE STUDENT');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(baseSystemPrompt.indexOf('FORMATTING REQUIREMENTS'));
    const block = baseSystemPrompt.slice(at, baseSystemPrompt.indexOf('FORMATTING REQUIREMENTS'));
    expect(block).toMatch(/second person/);
    expect(block).toMatch(/NEVER describe your plan or your next step/);
    expect(block).toMatch(/third person/);
    expect(block).toMatch(/how you grade/);
    expect(block).toMatch(/Put decisions into tool calls, not prose/);
  });

  it('keeps the mechanism out of a hint, and each question on new ground', () => {
    expect(baseSystemPrompt).toMatch(
      /Never restate the mechanism,\s+property or behavior you are hinting at/
    );
    expect(baseSystemPrompt).toMatch(
      /Never ask two questions about the same concept or the same piece of code/
    );
    expect(codeAwareAgentPrompt).toMatch(
      /Each question uses a different part of the student's code/
    );
  });

  it('gives every present_question example the required preamble', () => {
    for (const text of [baseSystemPrompt, codeAwareAgentPrompt]) {
      const json = [...text.matchAll(/"question_number":/g)];
      expect(json.length).toBeGreaterThan(0);
      for (const m of json) {
        const open = text.lastIndexOf('{', m.index);
        expect(text.slice(open, m.index)).toContain('"preamble"');
      }
      for (const m of text.matchAll(/\[Calls present_question tool with ([^\]\n]*)\]/g)) {
        expect(m[1]).toContain('preamble=');
      }
    }
  });

  it('rates "I don\'t know" as no_attempt and leaves clarifications and agreement unrated', () => {
    expect(baseSystemPrompt).toMatch(
      /"I don't know" \(or a submitted answer with nothing meaningful in it\) = an answer\s+rated no_attempt/
    );
    expect(baseSystemPrompt).toMatch(
      /"Yes" \/ "Exactly" \/ "That's what I meant".*\n\s+= NOT an answer: do not rate it/
    );
  });

  it('rates an answer with a real error or a missing piece below correct', () => {
    expect(baseSystemPrompt).toMatch(
      /An answer with a real error, or with a key piece missing, is NOT\s+correct/
    );
  });

  it('quotes the student code only verbatim from explorations, never from the material', () => {
    expect(codeAwareAgentPrompt).toMatch(/QUOTE THE STUDENT'S CODE ONLY VERBATIM/);
    expect(codeAwareAgentPrompt).toMatch(/Mark every cut with "\.\.\."/);
    expect(codeAwareAgentPrompt).toMatch(/NEVER quote the SOURCE MATERIAL/);
    expect(codeAwareAgentPrompt).toMatch(
      /check with explore_codebase, then correct\s+yourself in one sentence/
    );
  });

  it('tells the model to end its reply after offer_next_step', () => {
    expect(baseSystemPrompt).toMatch(/Call it LAST in your reply, then end your reply/);
  });

  it.each(bothModes)('%s: never offers buttons in the same reply as a new question', (_l, p) => {
    expect(p.staticPrompt).toMatch(
      /NEVER call offer_next_step in the same reply as present_question/
    );
    expect(p.staticPrompt).toMatch(/Call offer_next_step in the same reply/);
  });

  it('retries a failed exploration once, then asks about the concepts without the code', () => {
    const rule = codeAwareAgentPrompt.slice(
      codeAwareAgentPrompt.indexOf('IF explore_codebase FAILS (')
    );
    expect(rule).toMatch(/Call it at most once more/);
    expect(rule).toMatch(/quiz topic and the rubric concepts directly, with no code_snippet/);
    expect(rule).toMatch(/without\s+quoting or describing the student's code/);
    expect(rule).toMatch(/at most one short, neutral sentence/);
    expect(rule).toMatch(/Never mention tools, tokens, access, errors or failures to the student/);
    expect(codeAwareAgentPrompt).toMatch(
      /Never mention tools, tokens, repository access or errors to the student/
    );
    expect(codeAwareAgentPrompt).toMatch(/The one exception is IF explore_codebase FAILS below/);
  });

  it('carries on after an exploration that found no code instead of exploring again', () => {
    expect(codeAwareAgentPrompt).not.toMatch(/explore a different focus area\./i);
    expect(codeAwareAgentPrompt).toMatch(
      /returns no code, do not explore again for it: continue with the code\s+you have already seen/
    );
  });

  it.each(bothModes)('%s: never tells the student about tool errors or timing', (_l, p) => {
    expect(p.staticPrompt).not.toMatch(/few minutes|fresh access|expired access/);
    expect(p.staticPrompt).not.toMatch(/Only (tell|mention)[^.]*(problem|issues) if/);
    expect(p.staticPrompt).toMatch(/Never mention tools, tokens, access or errors to the student/);
  });

  it('shows record_question_result examples in the v3 shape only', () => {
    const calls = [
      ...`${baseSystemPrompt}\n${codeAwareAgentPrompt}`.matchAll(
        /record_question_result: \{[^\n]*/g
      ),
    ];
    expect(calls.length).toBeGreaterThan(0);
    for (const [call] of calls) {
      expect(call).toContain('answers');
      expect(call).toContain('hints_before');
    }
  });
});

describe('quiz prompt: the cached split', () => {
  it('keeps the static block byte-identical across question counts, subjects, difficulties, rubrics and overrides', () => {
    for (const isCodeAware of [false, true]) {
      const reference = buildQuizPrompt({ ...base, isCodeAware }).staticPrompt;
      const variants: Partial<QuizPromptInput>[] = [
        { questionCount: 3 },
        { questionCount: 12 },
        { subject: 'React hooks' },
        { subject: null },
        { difficultyLevel: 'Advanced' },
        { difficultyLevel: null },
        { rubricPrompt: 'Assess flexbox.' },
        { quizSystemPrompt: 'Be brief.' },
        { classroomRef: 'org/cs52-26f' },
      ];
      for (const variant of variants) {
        expect(buildQuizPrompt({ ...base, isCodeAware, ...variant }).staticPrompt).toBe(reference);
      }
    }
  });

  it('carries the instructor override and the rubric through byte-exact', () => {
    const quizSystemPrompt = '  Ask about **semantics**.\n\n- keep it short  ';
    const rubricPrompt = '1) box model\n2) specificity\t(tabs kept)';
    const { dynamicPrompt } = buildQuizPrompt({ ...base, quizSystemPrompt, rubricPrompt });
    expect(dynamicPrompt).toContain(`\n\n${quizSystemPrompt}`);
    expect(dynamicPrompt).toContain(`GRADING RUBRIC:\n${rubricPrompt}\n\n`);
  });

  it('puts the quiz parameters in the dynamic block', () => {
    const { dynamicPrompt } = buildQuizPrompt({ ...base, questionCount: 6 });
    expect(dynamicPrompt).toContain('SUBJECT: HTML & CSS');
    expect(dynamicPrompt).toContain('NUM_QUESTIONS: 6');
    expect(dynamicPrompt).toContain('DIFFICULTY_LEVEL: Beginner');
  });

  it('defaults the subject and difficulty as the previous builder did', () => {
    const { dynamicPrompt } = buildQuizPrompt({ ...base, subject: null, difficultyLevel: null });
    expect(dynamicPrompt).toContain('SUBJECT: [Subject not specified]');
    expect(dynamicPrompt).toContain('DIFFICULTY_LEVEL: Intermediate');
  });

  it('names exploration in the rubric line only for code-aware quizzes', () => {
    const rubricPrompt = 'Assess layout.';
    expect(buildQuizPrompt({ ...base, rubricPrompt }).dynamicPrompt).toContain(
      'Use this rubric to guide your questioning.'
    );
    expect(buildQuizPrompt({ ...base, rubricPrompt, isCodeAware: true }).dynamicPrompt).toContain(
      'Use this rubric to guide your exploration and questioning.'
    );
  });

  it('states the question count by reference in the fleet-wide text, never as a literal', () => {
    expect(codeAware.staticPrompt).not.toContain('NUM_QUESTIONS: ');
    expect(codeAware.staticPrompt).toContain('<NUM_QUESTIONS>');
  });
});

describe('quiz prompt: source material', () => {
  const sourceMaterial = [
    { kind: 'page', id: 'p1', title: 'Flexbox basics', text: 'Flex containers...\n\n' },
    { kind: 'slide', id: 's2', title: '', text: 'Specificity rules' },
    { kind: 'page', id: 'p3', title: 'Empty', text: '   ' },
  ];

  it('appends the material to the static block after one blank line, and leaves the dynamic block alone', () => {
    const withMaterial = buildQuizPrompt({ ...base, sourceMaterial, classroomRef: 'org/cs52' });
    expect(
      withMaterial.staticPrompt.startsWith(
        `${standard.staticPrompt}\n\n━━━ SOURCE MATERIAL (classroom: org/cs52) ━━━\n`
      )
    ).toBe(true);
    expect(withMaterial.dynamicPrompt).toBe(standard.dynamicPrompt);
  });

  it('renders every usable document in order with kind, title and id, and drops empty ones', () => {
    const { staticPrompt } = buildQuizPrompt({ ...base, sourceMaterial });
    const first = staticPrompt.indexOf(
      '=== page: "Flexbox basics" (id: p1) ===\nFlex containers...'
    );
    const second = staticPrompt.indexOf('=== slide: "Untitled" (id: s2) ===\nSpecificity rules');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(staticPrompt).not.toContain('(id: p3)');
  });

  it('names no content tool while the run has none', () => {
    const { staticPrompt } = buildQuizPrompt({
      ...base,
      sourceMaterial,
      classroomRef: 'org/cs52',
      courseSearchEnabled: true,
    });
    expect(staticPrompt).not.toMatch(/content_(get|search|list)/);
  });

  it('adds the code-aware scope rule only for a code-aware quiz with material', () => {
    const scope = 'In a code-aware quiz the material decides the topics';
    expect(buildQuizPrompt({ ...base, sourceMaterial, isCodeAware: true }).staticPrompt).toContain(
      scope
    );
    expect(buildQuizPrompt({ ...base, sourceMaterial }).staticPrompt).not.toContain(scope);
    expect(codeAware.staticPrompt).not.toContain(scope);
  });

  it('leaves a quiz without usable material on the fleet-wide block', () => {
    expect(buildQuizPrompt({ ...base, sourceMaterial: [] }).staticPrompt).toBe(
      standard.staticPrompt
    );
    expect(
      buildQuizPrompt({ ...base, sourceMaterial: [{ kind: 'page', id: 'x', text: '' }] })
        .staticPrompt
    ).toBe(standard.staticPrompt);
  });
});

describe('evaluationNotice', () => {
  it('names the presented questions that have no result, in order', () => {
    const text = evaluationNotice({
      questionCount: 8,
      presented: 8,
      finalized: [1, 2, 4, 5, 6, 7],
    });
    expect(text).toContain('no recorded result yet: 3, 8.');
    expect(text).toContain('record_question_result');
    expect(text).toContain('submit_quiz_evaluation');
  });

  it('asks only for the evaluation when every question is recorded', () => {
    const text = evaluationNotice({ questionCount: 3, presented: 3, finalized: [1, 2, 3] });
    expect(text).toContain('Every presented question has a recorded result.');
    expect(text).not.toContain('no recorded result yet');
  });

  it('carries no marker, credit or percentage', () => {
    const text = evaluationNotice({ questionCount: 2, presented: 2, finalized: [1] });
    expect(text).not.toMatch(/\d+\s*%|\[BUTTON:|credit_earned|\[QUESTION_/);
  });
});
