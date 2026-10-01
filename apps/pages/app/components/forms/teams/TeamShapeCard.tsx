import { useEffect, useRef, useState } from 'react';

import { optionRunsSummary, SETUP_ROW_IDS, sizeText, TEAMS_LABELS } from './teamsView.ts';
import type {
  SetupOption,
  SetupQuestion,
  SetupView,
  TeamSetConfig,
  TeamSetConfigPatchInput,
} from './types.ts';

/**
 * Setup's "Team shape" card: what the teams are made from, team size, number
 * of teams, teams per project, which projects run, and fairness. There is no
 * setting for uneven counts: the service lets the fewest teams go one off the
 * size (teamSetFlex.ts), and the checks state the fit.
 *
 * Grouping is chosen here, not on the question row (release-2 plan §0, "Job
 * select"): "Teams are made from" lists the ranked-choice and dropdown
 * questions that aren't identity questions, plus Free teams. Picking another
 * question (or Free teams) makes the service drop every project setting,
 * since they were keyed by the old question's options (applyConfigPatch);
 * the same question with a new teams-per-project count keeps them, so that
 * input posts the whole `grouping` with the current field id.
 *
 * Autosave, as the builder does it: numbers post on blur, the select on
 * change, the slider when it is let go. An input adopts the stored
 * value when newer data arrives unless it has focus (builder.tsx's idiom), so
 * a save from MCP or another tab shows up without clobbering typing.
 *
 * The teams-of-two note for identity rules comes in through `pairsNote`:
 * teamsView has no template for it yet, and this card writes no sentences of
 * its own.
 *
 * Presentational: props in, one patch per change out.
 */

export interface TeamShapeCardProps {
  /** The stored setup (SetupView.set.config); these four keys are read. */
  config: Pick<TeamSetConfig, 'grouping' | 'team_size' | 'team_count' | 'fairness'>;
  /** SetupView.shape: people to place and the team counts the sizes allow. */
  shape: SetupView['shape'];
  /**
   * Every question (SetupView.questions): the grouping choices, and whether
   * an identity rule is on (for the teams-of-two note).
   */
  questions: readonly Pick<SetupQuestion, 'field_id' | 'label' | 'type' | 'identity' | 'rules'>[];
  /** The grouping question's options (SetupView.options), for "Which projects run"; [] in free mode. */
  options: readonly Pick<SetupOption, 'label' | 'runs'>[];
  /** The set is created or creating: every control is disabled. */
  locked: boolean;
  /** Autosave: the route posts it as `intent: 'patch'`. */
  onPatch: (patch: TeamSetConfigPatchInput) => void;
  /** Shown when teams are pairs (max 2) and an identity rule is on; none shown when absent. */
  pairsNote?: string | null;
}

const GROUPING_TYPES: ReadonlySet<string> = new Set(['ranked_choice', 'dropdown']);
const FREE = '';

/** Team sizes and counts the config accepts (TeamSizeSchema, TeamCountSchema, GroupingSchema). */
const SIZE_BOUNDS = { min: 1, max: 50 } as const;
const COUNT_BOUNDS = { min: 1, max: 1000 } as const;
const TEAMS_PER_OPTION_BOUNDS = { min: 1, max: 20 } as const;

const inputClass =
  'w-16 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm tabular-nums text-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white';

const labelClass = 'text-sm text-gray-700 dark:text-gray-200';

// ─── Number drafts ──────────────────────────────────────────────────────────

type Range = { min: number | null; max: number | null };

const toText = (value: number | null): string => (value === null ? '' : String(value));

/** '' → null; an integer within the bounds → it; anything else → 'invalid'. */
function parseWhole(text: string, bounds: { min: number; max: number }): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) return 'invalid';
  return value;
}

export interface RangeInputsProps {
  /** Ids `${idPrefix}-min` and `${idPrefix}-max`. */
  idPrefix: string;
  /** The stored ends; null = not set. */
  value: Range;
  /** Integers the ends may take. */
  bounds: { min: number; max: number };
  placeholder?: { min?: string; max?: string };
  /** Both ends must be set (team size): a blank end goes back to the stored value. */
  required?: boolean;
  disabled: boolean;
  /** Id of the element that names the pair (a label or a column header, or several). */
  labelledBy: string;
  /** Called on blur with both ends, when they parse and differ from the stored ones. */
  onCommit: (next: Range) => void;
}

/**
 * A min "to" max pair of number inputs that commit together on blur, so a
 * change to one end posts with the other end as typed, not as stored.
 */
export function RangeInputs({
  idPrefix,
  value,
  bounds,
  placeholder,
  required = false,
  disabled,
  labelledBy,
  onCommit,
}: RangeInputsProps) {
  const [draft, setDraft] = useState({ min: toText(value.min), max: toText(value.max) });
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft({ min: toText(value.min), max: toText(value.max) });
  }, [value.min, value.max]);

  const commit = () => {
    focused.current = false;
    const min = parseWhole(draft.min, bounds);
    const max = parseWhole(draft.max, bounds);
    const badMin = min === 'invalid' || (required && min === null);
    const badMax = max === 'invalid' || (required && max === null);
    if (badMin || badMax) {
      setDraft({
        min: badMin ? toText(value.min) : draft.min,
        max: badMax ? toText(value.max) : draft.max,
      });
      return;
    }
    if (min === value.min && max === value.max) return;
    onCommit({ min: min as number | null, max: max as number | null });
  };

  const input = (end: 'min' | 'max') => (
    <input
      id={`${idPrefix}-${end}`}
      type="number"
      inputMode="numeric"
      min={bounds.min}
      max={bounds.max}
      step={1}
      value={draft[end]}
      placeholder={placeholder?.[end]}
      disabled={disabled}
      aria-labelledby={`${labelledBy} ${idPrefix}-${end}-label`}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={event => {
        const next = event.target.value;
        setDraft(current => ({ ...current, [end]: next }));
      }}
      onBlur={commit}
      className={inputClass}
    />
  );

  return (
    <span className="inline-flex items-center gap-1.5">
      <span id={`${idPrefix}-min-label`} className="sr-only">
        {TEAMS_LABELS.min}
      </span>
      {input('min')}
      <span className="text-xs text-gray-500 dark:text-gray-400" aria-hidden="true">
        {TEAMS_LABELS.rangeTo}
      </span>
      <span id={`${idPrefix}-max-label`} className="sr-only">
        {TEAMS_LABELS.max}
      </span>
      {input('max')}
    </span>
  );
}

/** One number input with the same draft rules as RangeInputs. */
function NumberInput({
  id,
  value,
  bounds,
  disabled,
  labelledBy,
  onCommit,
}: {
  id: string;
  value: number;
  bounds: { min: number; max: number };
  disabled: boolean;
  labelledBy: string;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={bounds.min}
      max={bounds.max}
      step={1}
      value={draft}
      disabled={disabled}
      aria-labelledby={labelledBy}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        const next = parseWhole(draft, bounds);
        if (next === null || next === 'invalid') {
          setDraft(String(value));
          return;
        }
        if (next !== value) onCommit(next);
      }}
      className={inputClass}
    />
  );
}

// ─── The card ───────────────────────────────────────────────────────────────

/** An identity question has a rule that isn't off. */
function identityRuleOn(questions: TeamShapeCardProps['questions']): boolean {
  return questions.some(
    question => question.identity && question.rules.some(rule => rule.strength !== 'off')
  );
}

export function TeamShapeCard({
  config,
  shape,
  questions,
  options,
  locked,
  onPatch,
  pairsNote,
}: TeamShapeCardProps) {
  const grouping = config.grouping;
  const byOption = grouping.mode === 'by_option';
  const groupingChoices = questions.filter(
    question => GROUPING_TYPES.has(question.type) && !question.identity
  );
  const size = config.team_size;
  const range = shape.team_count_range;
  const showPairsNote = size.max === 2 && identityRuleOn(questions) && Boolean(pairsNote);

  // The slider keeps its own value while it is dragged and posts when let go.
  // Letting go and then leaving it fire one after the other before the saved
  // value comes back, so the last posted value is remembered to post once.
  const [fairness, setFairness] = useState(config.fairness);
  const sliding = useRef(false);
  const posted = useRef<number | null>(null);
  useEffect(() => {
    posted.current = null;
    if (!sliding.current) setFairness(config.fairness);
  }, [config.fairness]);
  const commitFairness = () => {
    sliding.current = false;
    if (fairness === config.fairness || fairness === posted.current) return;
    posted.current = fairness;
    onPatch({ fairness });
  };

  // The stored question stays choosable even when it no longer qualifies
  // (the checks report that), so the select shows what is saved.
  const current = byOption
    ? questions.find(question => question.field_id === grouping.field_id)
    : undefined;
  if (current && !groupingChoices.includes(current)) groupingChoices.unshift(current);

  return (
    <section
      id={SETUP_ROW_IDS.teamShape}
      aria-labelledby="shape-heading"
      className="scroll-mt-24 rounded-xl border border-gray-200 bg-white p-4 data-[highlight=true]:ring-2 data-[highlight=true]:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:data-[highlight=true]:ring-blue-400"
    >
      <h2 id="shape-heading" className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
        {TEAMS_LABELS.teamShape}
      </h2>

      <div className="space-y-3">
        <div>
          <label htmlFor="shape-grouping" className={labelClass}>
            {TEAMS_LABELS.teamsMadeFrom}
          </label>
          <select
            id="shape-grouping"
            value={byOption ? grouping.field_id : FREE}
            disabled={locked}
            onChange={event => {
              const fieldId = event.target.value;
              if (fieldId === FREE) {
                if (byOption) onPatch({ grouping: { mode: 'free' } });
                return;
              }
              if (byOption && fieldId === grouping.field_id) return;
              onPatch({
                grouping: {
                  mode: 'by_option',
                  field_id: fieldId,
                  teams_per_option: byOption ? grouping.teams_per_option : 1,
                },
              });
            }}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
          >
            {groupingChoices.map(question => (
              <option key={question.field_id} value={question.field_id}>
                {question.label}
              </option>
            ))}
            <option value={FREE}>{TEAMS_LABELS.freeTeams}</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span id="shape-size-label" className={labelClass}>
            {TEAMS_LABELS.teamSize}
          </span>
          <RangeInputs
            idPrefix="shape-size"
            value={{ min: size.min, max: size.max }}
            bounds={SIZE_BOUNDS}
            required
            disabled={locked}
            labelledBy="shape-size-label"
            onCommit={next =>
              onPatch({ team_size: { min: next.min as number, max: next.max as number } })
            }
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={labelClass}>
            <span id="shape-count-label">{TEAMS_LABELS.numberOfTeams}</span>
            {range ? (
              <span
                data-testid="shape-count-range"
                className="ml-2 text-xs tabular-nums text-gray-500 dark:text-gray-400"
              >
                {sizeText(range)}
              </span>
            ) : null}
          </span>
          <RangeInputs
            idPrefix="shape-count"
            value={{ min: config.team_count.min ?? null, max: config.team_count.max ?? null }}
            bounds={COUNT_BOUNDS}
            placeholder={range ? { min: String(range.min), max: String(range.max) } : undefined}
            disabled={locked}
            labelledBy="shape-count-label"
            onCommit={next =>
              onPatch({
                team_count: {
                  ...(next.min !== null ? { min: next.min } : {}),
                  ...(next.max !== null ? { max: next.max } : {}),
                },
              })
            }
          />
        </div>

        {grouping.mode === 'by_option' ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span id="shape-teams-per-option-label" className={labelClass}>
                {TEAMS_LABELS.teamsPerProject}
              </span>
              <NumberInput
                id="shape-teams-per-option"
                value={grouping.teams_per_option}
                bounds={TEAMS_PER_OPTION_BOUNDS}
                disabled={locked}
                labelledBy="shape-teams-per-option-label"
                onCommit={next =>
                  onPatch({
                    grouping: {
                      mode: 'by_option',
                      field_id: grouping.field_id,
                      teams_per_option: next,
                    },
                  })
                }
              />
            </div>
            {options.length > 0 ? (
              <div>
                <div className={labelClass}>{TEAMS_LABELS.whichProjectsRun}</div>
                <p
                  data-testid="shape-runs-summary"
                  className="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
                >
                  {optionRunsSummary(options)}
                </p>
              </div>
            ) : null}
          </>
        ) : null}

        <div>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="shape-fairness" className={labelClass}>
              {TEAMS_LABELS.fairness}
            </label>
            <output
              htmlFor="shape-fairness"
              className="text-sm tabular-nums text-gray-700 dark:text-gray-200"
            >
              {`${fairness}%`}
            </output>
          </div>
          <input
            id="shape-fairness"
            type="range"
            min={0}
            max={100}
            step={1}
            value={fairness}
            disabled={locked}
            onPointerDown={() => {
              sliding.current = true;
            }}
            onChange={event => {
              sliding.current = true;
              setFairness(Number(event.target.value));
            }}
            onPointerUp={commitFairness}
            onKeyUp={commitFairness}
            onBlur={commitFairness}
            className="mt-1 w-full accent-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:accent-gray-100"
          />
          <div className="mt-0.5 flex justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>{TEAMS_LABELS.bestOverall}</span>
            <span>{TEAMS_LABELS.protectWorstOff}</span>
          </div>
        </div>

        {showPairsNote ? (
          <p data-testid="shape-pairs-note" className="text-xs text-gray-500 dark:text-gray-400">
            {pairsNote}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default TeamShapeCard;
