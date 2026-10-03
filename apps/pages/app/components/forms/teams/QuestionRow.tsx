import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import {
  DEFAULT_PRIORITY_SHIFT,
  DEFAULT_RULE_WEIGHT,
  PRIORITY_TARGET_JOBS,
  teamSetRuleId,
  type TeamSetPriorityAnswer,
} from '@classmoji/services/team-set-config';

import { metaFor } from '../fieldTypes.ts';
import { ActionErrorNote, type CreateFlowError } from './CreatingProgress.tsx';
import { IdentityQuestionBlock } from './IdentityQuestionBlock.tsx';
import { JobMenu } from './JobMenu.tsx';
import {
  answerCountText,
  JOB_LABELS,
  jobFactText,
  jobHintText,
  mustLabelFor,
  ON_OFF_LABELS,
  PRIORITY_ANSWER_LABELS,
  QUESTION_ROW_LABELS,
  questionControlLabel,
  questionCountsText,
  SETUP_ROW_IDS,
  STRENGTH_LABELS,
  studentsSeeText,
  TEAMS_LABELS,
  typeFactsText,
} from './teamsView.ts';
import type {
  AnswerCount,
  CheckLine,
  SetupQuestion,
  TeamSetConfigPatchInput,
  TeamSetJob,
  TeamSetRule,
  TeamSetStrength,
} from './types.ts';

/**
 * One question of Setup's Questions card: its type and label, the job it does
 * in the set (the Job menu, each job with its name and its fact, or the fixed
 * "Makes the teams" chip on the question the teams are made from), its
 * counts, and the controls of its rule: strength (Off / Prefer / Must, or
 * Off / On for jobs without a weight), weight, a line for the rule (jobFactText:
 * the job's aim; at Must the Must sentence; at Off, or an identity rule when
 * the teams are pairs, that it isn't used), a detail line (rank's costs, the
 * shift), and per job:
 *   - identity question (no_one_alone): IdentityQuestionBlock — "Don't leave
 *     anyone as the only:" checkboxes with class counts, the checks about it,
 *     "Students see"; Must is never offered;
 *   - Shifts priority: rule A and rule B (the active rules a priority rule
 *     can name, by question), per answer A counts more / B counts more / No
 *     change with class counts, and the shift (10–90%);
 *   - note: Read notes (the Responses page).
 *
 * Autosave, one patch per change, as the builder does it: buttons, selects,
 * the Job menu and checkboxes post on change, sliders when let go. A control keeps its own
 * draft from the click until the saved setup comes back (so two quick clicks
 * on the answers or the checkboxes, whose lists a patch replaces whole, don't
 * lose the first), and goes back to the stored value when a save is refused.
 *
 * Rules a patch writes:
 *   - a new rule carries a strength; a priority rule starts Off, and turning
 *     it On sends rule A and rule B with it when either is unset;
 *   - changing the job removes the old rule and adds the new one in the same
 *     patch, keeping the strength (Must becomes Prefer where the new job has
 *     no Must) and the weight; "Not used" removes the question's rules.
 *
 * The row's element id is `SETUP_ROW_IDS.question(field_id)`, so a Can't-solve
 * link lands on it; the page sets `data-highlight` on the target.
 *
 * Presentational: props in, one patch per change out.
 */

/** The order of a priority rule's answer effects. */
const PRIORITY_ANSWERS: readonly TeamSetPriorityAnswer[] = ['a', 'b', 'none'];

// ─── Priority targets ───────────────────────────────────────────────────────

/** A rule a Shifts priority rule can name as A or B. */
export interface PriorityTarget {
  /** `<field_id>:<job>` (teamSetRuleId). */
  rule_id: string;
  field_id: string;
  job: TeamSetJob;
  /** The question's label. */
  label: string;
  /** The rule isn't Off. */
  active: boolean;
}

/** Every rule of a job a priority rule can name, on every question, in question order. */
export function priorityTargets(
  questions: readonly Pick<SetupQuestion, 'label' | 'rules'>[]
): PriorityTarget[] {
  return questions.flatMap(question =>
    question.rules
      .filter(rule => PRIORITY_TARGET_JOBS.includes(rule.job))
      .map(rule => ({
        rule_id: teamSetRuleId(rule),
        field_id: rule.field_id,
        job: rule.job,
        label: question.label,
        active: rule.strength !== 'off',
      }))
  );
}

/** The select's text for a target: the question, and the job's name when two share a question. */
function targetText(target: PriorityTarget, all: readonly PriorityTarget[]): string {
  const shared = all.filter(other => other.label === target.label).length > 1;
  return shared ? `${target.label} (${JOB_LABELS[target.job]})` : target.label;
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

const WEIGHTLESS_JOBS: ReadonlySet<TeamSetJob> = new Set(['note', 'priority']);

/** One entry of a patch's `rules.upsert`, and the part a control fills in. */
type RuleUpsert = NonNullable<NonNullable<TeamSetConfigPatchInput['rules']>['upsert']>[number];
type RuleUpsertFields = Partial<Omit<RuleUpsert, 'field_id' | 'job'>>;

/** The strength a rule keeps when its job changes. */
function carriedStrength(
  from: TeamSetStrength,
  job: TeamSetJob,
  question: Pick<SetupQuestion, 'must_labels'>
): TeamSetStrength {
  if (job === 'priority') return 'off';
  if (from === 'must' && !mustLabelFor(question, job)) return 'prefer';
  return from;
}

/** A value that follows the stored one, except while the user changes it, and after a refused save. */
function useDraft<T>(stored: T, storedKey: string, error: unknown): [T, (next: T) => void] {
  const [draft, setDraft] = useState(stored);
  useEffect(() => {
    setDraft(stored);
    // `storedKey` stands for `stored` (objects compare by identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey, error]);
  return [draft, setDraft];
}

const segmentBase =
  'whitespace-nowrap px-2.5 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50';
const segmentOn = 'bg-gray-900 text-white dark:bg-white dark:text-gray-900';
const segmentOff =
  'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800';

/**
 * On a narrow phone (≤ 380px wide) a `narrow="fill"` control takes the row's
 * width in equal columns and lets each label wrap, instead of running past
 * the card's edge.
 */
const segmentFill = {
  group: 'max-[380px]:grid max-[380px]:w-full max-[380px]:auto-cols-fr max-[380px]:grid-flow-col',
  button: 'max-[380px]:whitespace-normal max-[380px]:leading-tight',
} as const;

function Segmented<V extends string>({
  idPrefix,
  label,
  values,
  labels,
  value,
  disabled,
  disabledValues,
  narrow,
  onChange,
}: {
  idPrefix: string;
  label: string;
  values: readonly V[];
  labels: Readonly<Record<V, string>>;
  value: V | null;
  disabled: boolean;
  disabledValues?: ReadonlySet<V>;
  /** 'fill': on a narrow phone, equal columns with wrapping labels. */
  narrow?: 'fill';
  onChange: (next: V) => void;
}) {
  const fill = narrow === 'fill';
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600 ${
        fill ? segmentFill.group : ''
      }`}
    >
      {values.map((option, index) => (
        <button
          key={option}
          id={`${idPrefix}-${option}`}
          type="button"
          aria-pressed={value === option}
          disabled={disabled || disabledValues?.has(option)}
          onClick={() => {
            if (option !== value) onChange(option);
          }}
          className={`${segmentBase} ${fill ? segmentFill.button : ''} ${
            value === option ? segmentOn : segmentOff
          } ${index > 0 ? 'border-l border-gray-300 dark:border-gray-600' : ''}`}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

/** A range input that keeps its value while dragged and posts once when let go. */
function CommitSlider({
  id,
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled: boolean;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const sliding = useRef(false);
  const posted = useRef<number | null>(null);
  useEffect(() => {
    posted.current = null;
    if (!sliding.current) setDraft(value);
  }, [value]);
  const commit = () => {
    sliding.current = false;
    if (draft === value || draft === posted.current) return;
    posted.current = draft;
    onCommit(draft);
  };

  return (
    <span className="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onPointerDown={() => {
          sliding.current = true;
        }}
        onChange={event => {
          sliding.current = true;
          setDraft(Number(event.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-28 accent-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:accent-gray-100"
      />
      <output htmlFor={id} className="w-9 tabular-nums text-gray-800 dark:text-gray-100">
        {`${draft}${suffix}`}
      </output>
    </span>
  );
}

// ─── Shifts priority ────────────────────────────────────────────────────────

function PriorityControls({
  idPrefix,
  rule,
  on,
  answers,
  targets,
  disabled,
  error,
  upsert,
}: {
  idPrefix: string;
  rule: TeamSetRule | undefined;
  /** The rule's strength as drafted: rule A and B can't be emptied while it is On. */
  on: boolean;
  answers: readonly AnswerCount[];
  targets: readonly PriorityTarget[];
  disabled: boolean;
  error: unknown;
  upsert: (fields: RuleUpsertFields) => void;
}) {
  const params = rule?.params ?? {};
  const [a, setA] = useDraft(params.rule_a ?? '', params.rule_a ?? '', error);
  const [b, setB] = useDraft(params.rule_b ?? '', params.rule_b ?? '', error);
  const storedAnswers = params.answers ?? {};
  const [effects, setEffects] = useDraft<Record<string, TeamSetPriorityAnswer>>(
    storedAnswers,
    JSON.stringify(storedAnswers),
    error
  );

  const shown = targets.filter(
    target => target.active || target.rule_id === a || target.rule_id === b
  );

  const select = (which: 'a' | 'b') => {
    const value = which === 'a' ? a : b;
    const other = which === 'a' ? b : a;
    const id = `${idPrefix}-rule-${which}`;
    const choices = shown.filter(target => target.rule_id !== other);
    const known = value === '' || shown.some(target => target.rule_id === value);
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-gray-900 text-[11px] font-semibold text-white dark:bg-white dark:text-gray-900"
        >
          {which.toUpperCase()}
        </span>
        <select
          id={id}
          aria-label={which === 'a' ? QUESTION_ROW_LABELS.ruleA : QUESTION_ROW_LABELS.ruleB}
          value={value}
          disabled={disabled}
          onChange={event => {
            const next = event.target.value;
            if (which === 'a') setA(next);
            else setB(next);
            upsert({
              params: { [which === 'a' ? 'rule_a' : 'rule_b']: next === '' ? null : next },
            });
          }}
          className="min-w-0 max-w-[18rem] rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
        >
          {value === '' || !on ? <option value="">{QUESTION_ROW_LABELS.noRule}</option> : null}
          {!known ? <option value={value}>{QUESTION_ROW_LABELS.ruleNotInSetup}</option> : null}
          {choices.map(target => (
            <option key={target.rule_id} value={target.rule_id}>
              {targetText(target, shown)}
            </option>
          ))}
        </select>
      </span>
    );
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {select('a')}
        {select('b')}
      </div>
      {answers.length > 0 ? (
        <div
          role="group"
          aria-label={QUESTION_ROW_LABELS.answersGroup}
          className="space-y-1.5 rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800/60"
        >
          {answers.map(answer => (
            <div
              key={answer.option_id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span className="text-sm text-gray-800 dark:text-gray-100">
                {answerCountText(answer)}
              </span>
              <Segmented
                idPrefix={`${idPrefix}-answer-${answer.option_id}`}
                label={answer.label}
                values={PRIORITY_ANSWERS}
                labels={PRIORITY_ANSWER_LABELS}
                value={effects[answer.option_id] ?? 'none'}
                disabled={disabled}
                narrow="fill"
                onChange={next => {
                  const merged = { ...effects, [answer.option_id]: next };
                  setEffects(merged);
                  upsert({ params: { answers: merged } });
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── One rule's controls ────────────────────────────────────────────────────

function RuleControls({
  idPrefix,
  question,
  job,
  rule,
  targets,
  checks,
  notesHref,
  locked,
  error,
  onPatch,
}: {
  /** Prefix of every control id: the row id for the question's job, `${row}-${job}` for another rule. */
  idPrefix: string;
  question: SetupQuestion;
  job: TeamSetJob;
  /** undefined = the question has no rule for this job yet (the first change adds it). */
  rule: TeamSetRule | undefined;
  targets: readonly PriorityTarget[];
  checks: readonly CheckLine[];
  notesHref: string | null;
  locked: boolean;
  error: unknown;
  onPatch: (patch: TeamSetConfigPatchInput) => void;
}) {
  const [strength, setStrength] = useDraft<TeamSetStrength>(
    rule?.strength ?? 'off',
    rule?.strength ?? 'off',
    error
  );
  const storedWildcards = rule?.params.wildcard_option_ids ?? [];
  const [wildcards, setWildcards] = useDraft<string[]>(
    storedWildcards,
    storedWildcards.join(','),
    error
  );

  const weightless = WEIGHTLESS_JOBS.has(job);
  const mustLabel = mustLabelFor(question, job);
  const strengths: TeamSetStrength[] = mustLabel ? ['off', 'prefer', 'must'] : ['off', 'prefer'];
  const params = rule?.params ?? {};

  /** One upsert of this rule; a new rule carries the drafted strength. */
  const upsert = (fields: RuleUpsertFields) => {
    onPatch({
      rules: {
        upsert: [
          {
            field_id: question.field_id,
            job,
            ...(rule ? {} : { strength }),
            ...fields,
          },
        ],
      },
    });
  };

  // Shifts priority: On needs rule A and rule B; unset ones are filled with
  // the first active targets, and On is refused when there aren't two.
  const priorityDefaults = (): { rule_a: string; rule_b: string } | null => {
    const active = targets.filter(target => target.active).map(target => target.rule_id);
    const a = params.rule_a ?? active.find(id => id !== params.rule_b);
    const b = params.rule_b ?? active.find(id => id !== a);
    return a && b && a !== b ? { rule_a: a, rule_b: b } : null;
  };
  const cannotTurnOn = job === 'priority' && strength === 'off' && priorityDefaults() === null;

  const changeStrength = (next: TeamSetStrength) => {
    if (next === strength) return;
    if (job === 'priority' && next !== 'off') {
      const pair = priorityDefaults();
      if (!pair) return;
      setStrength(next);
      const missing = params.rule_a === undefined || params.rule_b === undefined;
      upsert({ strength: next, ...(missing ? { params: pair } : {}) });
      return;
    }
    setStrength(next);
    upsert({ strength: next });
  };

  const identity = question.identity && job === 'no_one_alone';
  // The identity_rule_pairs check names this rule: it is off when the teams are pairs.
  const ruleId = teamSetRuleId({ field_id: question.field_id, job });
  const offForPairs =
    identity &&
    checks.some(check => check.code === 'identity_rule_pairs' && check.srcs?.includes(ruleId));
  // The line under the controls follows the drafted strength (jobFactText).
  const fact = jobFactText(question, job, params, strength, offForPairs);
  const hint = jobHintText(question, job, params);

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          idPrefix={`${idPrefix}-strength`}
          label={questionControlLabel(QUESTION_ROW_LABELS.strength, question.label, job)}
          values={strengths}
          labels={weightless ? ON_OFF_LABELS : STRENGTH_LABELS}
          value={strength}
          disabled={locked}
          disabledValues={cannotTurnOn ? new Set<TeamSetStrength>(['prefer']) : undefined}
          onChange={changeStrength}
        />
        {!weightless && strength === 'prefer' ? (
          <CommitSlider
            id={`${idPrefix}-weight`}
            label={QUESTION_ROW_LABELS.weight}
            value={rule?.weight ?? DEFAULT_RULE_WEIGHT}
            min={1}
            max={10}
            step={1}
            disabled={locked}
            onCommit={weight => upsert({ weight })}
          />
        ) : null}
        {job === 'priority' ? (
          <CommitSlider
            id={`${idPrefix}-shift`}
            label={QUESTION_ROW_LABELS.shift}
            value={params.shift ?? DEFAULT_PRIORITY_SHIFT}
            min={10}
            max={90}
            step={10}
            suffix="%"
            disabled={locked}
            onCommit={shift => upsert({ params: { shift } })}
          />
        ) : null}
        {question.identity ? (
          <span
            data-testid={`${idPrefix}-no-must`}
            className="text-xs text-gray-500 dark:text-gray-400"
          >
            {QUESTION_ROW_LABELS.noMustIdentity}
          </span>
        ) : null}
        {job === 'note' && notesHref ? (
          <Link
            to={notesHref}
            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {TEAMS_LABELS.readNotes}
          </Link>
        ) : null}
      </div>

      <p data-testid={`${idPrefix}-fact`} className="mt-2 text-xs text-gray-700 dark:text-gray-300">
        {fact}
      </p>
      {hint ? (
        <p
          data-testid={`${idPrefix}-hint`}
          className="mt-1 text-xs text-gray-500 dark:text-gray-400"
        >
          {hint}
        </p>
      ) : null}

      {job === 'priority' ? (
        <PriorityControls
          idPrefix={idPrefix}
          rule={rule}
          on={strength !== 'off'}
          answers={question.answer_counts ?? []}
          targets={targets}
          disabled={locked}
          error={error}
          upsert={upsert}
        />
      ) : null}

      {identity ? (
        <IdentityQuestionBlock
          idPrefix={idPrefix}
          answers={question.answer_counts ?? []}
          wildcards={wildcards}
          checks={checks}
          helpText={question.help_text}
          disabled={locked}
          onChange={next => {
            setWildcards(next);
            upsert({ params: { wildcard_option_ids: next.length > 0 ? next : null } });
          }}
        />
      ) : null}
    </div>
  );
}

// ─── The row ────────────────────────────────────────────────────────────────

export interface QuestionRowProps {
  /** One of SetupView.questions. */
  question: SetupQuestion;
  /** This question makes the teams (SetupView.grouping.field_id): the job is fixed to its rank rule. */
  grouping: boolean;
  /** The rules a Shifts priority rule can name (`priorityTargets` over every question). */
  priorityTargets: readonly PriorityTarget[];
  /** Checks about this question's rules (the identity single-answer and teams-of-two lines). */
  checks: readonly CheckLine[];
  /** The form's Responses page, for a note question's Read notes; null = none shown. */
  notesHref: string | null;
  /** The set is created or creating: every control is disabled. */
  locked: boolean;
  /** Autosave: the route posts it as `intent: 'patch'`. */
  onPatch: (patch: TeamSetConfigPatchInput) => void;
  /**
   * The refusal of this row's last save (a new object per answer): shown
   * under the row, and every draft goes back to the stored value.
   */
  error?: CreateFlowError | null;
}

export function QuestionRow({
  question,
  grouping,
  priorityTargets: targets,
  checks,
  notesHref,
  locked,
  onPatch,
  error = null,
}: QuestionRowProps) {
  const { field_id: fieldId, rules } = question;
  const rowId = SETUP_ROW_IDS.question(fieldId);

  // The grouping question's job is its rank rule; any other question's is its
  // first rule, or none.
  const primary = grouping ? rules.find(rule => rule.job === 'rank') : rules[0];
  const job: TeamSetJob | null = primary?.job ?? (grouping ? 'rank' : null);
  const extras = rules.filter(rule => rule !== primary);
  const [jobDraft, setJobDraft] = useDraft<string>(job ?? '', job ?? '', error);

  // An email question's answers are never shown as notes: the menu doesn't
  // offer Show as note there (a stored note rule still shows as the job).
  const jobChoices = question.jobs_allowed.filter(
    choice => !(choice === 'note' && question.type === 'email')
  );
  if (job && !jobChoices.includes(job)) jobChoices.unshift(job);
  // Each choice's fact reads the params of the question's rule for that job,
  // if it has one (a job chosen here starts without params).
  const menuChoices = [
    { value: '', name: QUESTION_ROW_LABELS.noJob, fact: jobFactText(question, null) },
    ...jobChoices.map(choice => ({
      value: choice,
      name: JOB_LABELS[choice],
      fact: jobFactText(question, choice, rules.find(rule => rule.job === choice)?.params),
    })),
  ];

  const changeJob = (next: string) => {
    if (next === (job ?? '')) return;
    setJobDraft(next);
    if (next === '') {
      onPatch({ rules: { remove: rules.map(rule => ({ field_id: fieldId, job: rule.job })) } });
      return;
    }
    const nextJob = next as TeamSetJob;
    const strength: TeamSetStrength = primary
      ? carriedStrength(primary.strength, nextJob, question)
      : nextJob === 'priority'
        ? 'off'
        : 'prefer';
    onPatch({
      rules: {
        ...(primary ? { remove: [{ field_id: fieldId, job: primary.job }] } : {}),
        upsert: [
          {
            field_id: fieldId,
            job: nextJob,
            strength,
            ...(primary ? { weight: primary.weight } : {}),
          },
        ],
      },
    });
  };

  const typeName = metaFor(question.type)?.label ?? question.type;
  const facts = typeFactsText(question.type_facts);
  // An identity question with no rule yet still shows its answers and what
  // students see; ticking an answer adds the rule (Off). One that can't take
  // the rule (a text question: no answers to count) shows what students see.
  const hasIdentityRule = rules.some(rule => rule.job === 'no_one_alone');
  const canProtect =
    question.jobs_allowed.includes('no_one_alone') && (question.answer_counts?.length ?? 0) > 0;
  const identityWithoutRule = question.identity && !hasIdentityRule && canProtect;
  const studentsSeeOnly =
    question.identity && !hasIdentityRule && !canProtect ? question.help_text : null;

  return (
    <li
      id={rowId}
      data-testid={rowId}
      className="scroll-mt-24 px-4 py-4 data-[highlight=true]:bg-blue-50 data-[highlight=true]:ring-2 data-[highlight=true]:ring-inset data-[highlight=true]:ring-blue-500 dark:data-[highlight=true]:bg-blue-950/40 dark:data-[highlight=true]:ring-blue-400"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <span>{facts ? `${typeName} · ${facts}` : typeName}</span>
            {question.identity ? (
              <span
                data-testid={`${rowId}-identity-chip`}
                className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200"
              >
                {QUESTION_ROW_LABELS.identityChip}
              </span>
            ) : null}
          </div>
          <div
            data-testid={`${rowId}-label`}
            className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white"
          >
            {question.label}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          {grouping ? (
            <span
              data-testid={`${rowId}-makes-teams`}
              className="rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            >
              {QUESTION_ROW_LABELS.makesTheTeams}
            </span>
          ) : jobChoices.length > 0 ? (
            <div className="inline-flex items-center gap-1.5">
              {/* The button's own name starts with "Job: <question>". */}
              <span aria-hidden="true">{QUESTION_ROW_LABELS.job}</span>
              <JobMenu
                id={`${rowId}-job`}
                label={questionControlLabel(QUESTION_ROW_LABELS.job, question.label)}
                choices={menuChoices}
                value={jobDraft}
                disabled={locked}
                onChange={changeJob}
              />
            </div>
          ) : null}
          <span data-testid={`${rowId}-counts`} className="tabular-nums">
            {questionCountsText(question.counts)}
          </span>
        </div>
      </div>

      {job ? (
        <RuleControls
          idPrefix={rowId}
          question={question}
          job={job}
          rule={primary}
          targets={targets}
          checks={checks}
          notesHref={notesHref}
          locked={locked}
          error={error}
          onPatch={onPatch}
        />
      ) : jobChoices.length > 0 ? (
        <p data-testid={`${rowId}-fact`} className="mt-2 text-xs text-gray-700 dark:text-gray-300">
          {jobFactText(question, null)}
        </p>
      ) : null}

      {identityWithoutRule ? (
        <IdentityQuestionBlock
          idPrefix={rowId}
          answers={question.answer_counts ?? []}
          wildcards={[]}
          checks={checks}
          helpText={question.help_text}
          disabled={locked}
          onChange={next =>
            onPatch({
              rules: {
                upsert: [
                  {
                    field_id: fieldId,
                    job: 'no_one_alone',
                    strength: 'off',
                    params: { wildcard_option_ids: next.length > 0 ? next : null },
                  },
                ],
              },
            })
          }
        />
      ) : null}

      {studentsSeeOnly ? (
        <p
          data-testid={`${rowId}-students-see`}
          className="mt-2 text-xs italic text-gray-500 dark:text-gray-400"
        >
          {studentsSeeText(studentsSeeOnly)}
        </p>
      ) : null}

      {extras.map(rule => (
        <div
          key={rule.job}
          className="mt-3 border-t border-dashed border-gray-200 pt-2 dark:border-gray-700"
        >
          <div className="text-xs text-gray-500 dark:text-gray-400">{JOB_LABELS[rule.job]}</div>
          <RuleControls
            idPrefix={`${rowId}-${rule.job}`}
            question={question}
            job={rule.job}
            rule={rule}
            targets={targets}
            checks={checks}
            notesHref={notesHref}
            locked={locked}
            error={error}
            onPatch={onPatch}
          />
        </div>
      ))}

      {error ? (
        <div className="mt-3">
          <ActionErrorNote error={error} />
        </div>
      ) : null}
    </li>
  );
}

export default QuestionRow;
