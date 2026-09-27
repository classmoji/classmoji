import { useEffect, useRef, useState } from 'react';

import { OPTION_NOTE_MAX_CHARS } from '@classmoji/services/team-set-config';

import { AddPinForm } from './AddPinForm.tsx';
import { RangeInputs } from './TeamShapeCard.tsx';
import {
  closedProvenanceText,
  OPTION_RUNS_LABELS,
  pinnedHereText,
  pitchersText,
  SETUP_ROW_IDS,
  TEAMS_LABELS,
  wantedText,
} from './teamsView.ts';
import type { PersonRef, SetupOption, TeamSetConfigPatchInput } from './types.ts';

/**
 * Setup's Projects table (grouped sets only): per option of the grouping
 * question, its name and description, how many wanted it (1st · top 3),
 * whether it runs (Solver decides / Always / Closed, with who closed it and
 * before which run), its own team size, its pitchers, who is pinned to it
 * with the pin's reason (+ Add person, an On pin), and the note an
 * instructor typed.
 *
 * Each row carries `SETUP_ROW_IDS.option(id)`, so a Can't-solve link lands
 * on it. Controls are named by the row's project name plus the column header
 * (aria-labelledby), so no label is spelled twice.
 *
 * Autosave: the segmented control posts on click, the size and the note on
 * blur; a size with both ends blank goes back to the set's team size.
 * The line under the table comes in through `footnote`: teamsView has no
 * template for it yet, and this table writes no sentences of its own.
 *
 * Presentational: props in, one patch per change out.
 */

export interface ProjectsTableProps {
  /** SetupView.options. */
  options: readonly SetupOption[];
  /** The set's team size (config.team_size): the size inputs' placeholders. */
  teamSize: { min: number; max: number };
  /** People "+ Add person" offers (SetupView.roster). */
  roster: readonly PersonRef[];
  /** The viewer's user id: "You closed it before run 6". */
  viewerId: string;
  /** The set is created or creating: every control is disabled. */
  locked: boolean;
  /** Autosave: the route posts it as `intent: 'patch'`. */
  onPatch: (patch: TeamSetConfigPatchInput) => void;
  /** Shown under the table; none shown when absent. */
  footnote?: string | null;
}

/** Option sizes the config accepts (OptionSizeSchema). */
const SIZE_BOUNDS = { min: 1, max: 50 } as const;

const RUNS: readonly SetupOption['runs'][] = ['auto', 'open', 'closed'];

const COLUMNS = [
  { key: 'project', label: TEAMS_LABELS.project },
  { key: 'wanted', label: TEAMS_LABELS.wantedColumn },
  { key: 'runs', label: TEAMS_LABELS.runs },
  { key: 'size', label: TEAMS_LABELS.size },
  { key: 'pitcher', label: TEAMS_LABELS.pitcher },
  { key: 'pinned', label: TEAMS_LABELS.pinnedHere },
  { key: 'note', label: TEAMS_LABELS.note },
] as const;

const columnId = (key: (typeof COLUMNS)[number]['key']) => `projects-col-${key}`;

/** The typed note: adopts newer stored text unless it has focus; posts on blur. */
function NoteInput({
  id,
  note,
  labelledBy,
  disabled,
  onCommit,
}: {
  id: string;
  note: string | null;
  labelledBy: string;
  disabled: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(note ?? '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(note ?? '');
  }, [note]);

  return (
    <textarea
      id={id}
      rows={2}
      value={draft}
      maxLength={OPTION_NOTE_MAX_CHARS}
      disabled={disabled}
      aria-labelledby={labelledBy}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        const next = draft.trim();
        if (next !== (note ?? '')) onCommit(next);
      }}
      className="block w-48 min-w-[10rem] rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
    />
  );
}

function ProjectRow({
  option,
  teamSize,
  roster,
  viewerId,
  locked,
  onPatch,
}: Omit<ProjectsTableProps, 'options' | 'footnote'> & { option: SetupOption }) {
  const [adding, setAdding] = useState(false);
  const rowId = SETUP_ROW_IDS.option(option.option_id);
  const nameId = `${rowId}-name`;
  const closed = option.runs === 'closed';
  const patchOption = (settings: NonNullable<TeamSetConfigPatchInput['options']>[string]) =>
    onPatch({ options: { [option.option_id]: settings } });
  const noPitcher = option.pitchers.every(pitcher => !pitcher.on_roster);

  return (
    <tr
      id={rowId}
      data-runs={option.runs}
      className="scroll-mt-24 align-top data-[highlight=true]:bg-blue-50 dark:data-[highlight=true]:bg-blue-950/40"
    >
      <td className="px-3 py-3">
        <span
          id={nameId}
          className={`block text-sm font-medium ${
            closed ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-white'
          }`}
        >
          {option.label}
        </span>
        {option.description ? (
          <span className="block max-w-xs text-xs text-gray-500 dark:text-gray-400">
            {option.description}
          </span>
        ) : null}
      </td>

      <td className="whitespace-nowrap px-3 py-3 text-sm tabular-nums text-gray-700 dark:text-gray-200">
        {wantedText(option.wanted)}
      </td>

      <td className="px-3 py-3">
        <div
          role="group"
          aria-labelledby={`${nameId} ${columnId('runs')}`}
          className="inline-flex gap-0.5 rounded-lg border border-gray-200 bg-gray-50 p-0.5 dark:border-gray-700 dark:bg-gray-800"
        >
          {RUNS.map(runs => {
            const on = option.runs === runs;
            return (
              <button
                key={runs}
                id={`${rowId}-runs-${runs}`}
                type="button"
                aria-pressed={on}
                disabled={locked}
                onClick={() => {
                  if (!on) patchOption({ open: runs });
                }}
                className={`whitespace-nowrap rounded-md px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${
                  on
                    ? 'bg-white font-semibold text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                    : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
                }`}
              >
                {OPTION_RUNS_LABELS[runs]}
              </button>
            );
          })}
        </div>
        {closed && option.closed ? (
          <span
            data-testid={`${rowId}-closed`}
            className="mt-1 block text-xs text-gray-500 dark:text-gray-400"
          >
            {closedProvenanceText(option.closed, viewerId)}
          </span>
        ) : null}
      </td>

      <td className="whitespace-nowrap px-3 py-3">
        <RangeInputs
          idPrefix={`${rowId}-size`}
          value={{ min: option.size?.min ?? null, max: option.size?.max ?? null }}
          bounds={SIZE_BOUNDS}
          placeholder={{ min: String(teamSize.min), max: String(teamSize.max) }}
          disabled={locked}
          labelledBy={`${nameId} ${columnId('size')}`}
          onCommit={next =>
            patchOption({
              size:
                next.min === null && next.max === null
                  ? null
                  : {
                      ...(next.min !== null ? { min: next.min } : {}),
                      ...(next.max !== null ? { max: next.max } : {}),
                    },
            })
          }
        />
      </td>

      <td
        className={`px-3 py-3 text-sm ${
          noPitcher ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-200'
        }`}
      >
        {pitchersText(option.pitchers)}
      </td>

      <td className="px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {option.pinned_here.map(pinned => (
            <span
              key={pinned.pin_id}
              data-pin-id={pinned.pin_id}
              title={pinnedHereText(pinned)}
              className="max-w-[16rem] truncate rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200"
            >
              {pinnedHereText(pinned)}
            </span>
          ))}
          {closed ? null : (
            <button
              id={`${rowId}-add-person`}
              type="button"
              aria-expanded={adding}
              aria-labelledby={`${rowId}-add-person ${nameId}`}
              disabled={locked}
              onClick={() => setAdding(open => !open)}
              className="whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
            >
              + {TEAMS_LABELS.addPerson}
            </button>
          )}
        </div>
        {adding && !closed && !locked ? (
          <div className="mt-2 w-64">
            <AddPinForm
              idPrefix={`${rowId}-pin`}
              roster={roster}
              options={[{ option_id: option.option_id, label: option.label }]}
              optionId={option.option_id}
              excludeUserIds={option.pinned_here.map(pinned => pinned.user_id)}
              onAdd={pin => {
                onPatch({ pins: { add: [pin] } });
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : null}
      </td>

      <td className="px-3 py-3">
        <NoteInput
          id={`${rowId}-note`}
          note={option.note}
          labelledBy={`${nameId} ${columnId('note')}`}
          disabled={locked}
          onCommit={next => patchOption({ note: next })}
        />
      </td>
    </tr>
  );
}

export function ProjectsTable({
  options,
  teamSize,
  roster,
  viewerId,
  locked,
  onPatch,
  footnote,
}: ProjectsTableProps) {
  return (
    <section
      id={SETUP_ROW_IDS.projects}
      aria-labelledby="projects-heading"
      className="scroll-mt-24 rounded-xl border border-gray-200 bg-white p-4 data-[highlight=true]:ring-2 data-[highlight=true]:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:data-[highlight=true]:ring-blue-400"
    >
      <h2
        id="projects-heading"
        className="mb-3 text-sm font-semibold text-gray-900 dark:text-white"
      >
        {TEAMS_LABELS.projects}
      </h2>
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              {COLUMNS.map(column => (
                <th
                  key={column.key}
                  id={columnId(column.key)}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {options.map(option => (
              <ProjectRow
                key={option.option_id}
                option={option}
                teamSize={teamSize}
                roster={roster}
                viewerId={viewerId}
                locked={locked}
                onPatch={onPatch}
              />
            ))}
          </tbody>
        </table>
      </div>
      {footnote ? (
        <p
          data-testid="projects-footnote"
          className="mt-2 text-xs text-gray-500 dark:text-gray-400"
        >
          {footnote}
        </p>
      ) : null}
    </section>
  );
}

export default ProjectsTable;
