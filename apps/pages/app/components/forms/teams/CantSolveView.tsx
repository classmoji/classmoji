import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Runline, type RunlineRun } from './Runline.tsx';
import {
  cantSolveHeading,
  cantSolveIntro,
  closedProvenanceText,
  coreLinkHash,
  coreLinkLabel,
  corePeopleText,
  quoted,
} from './teamsView.ts';
import type { CoreItem, RunViewModel } from './types.ts';

/**
 * A run the engine could not solve: the runline ("Run 6 · not solved", with
 * what changed since the run before it), the heading and the line above the
 * engine's conflict list, the list, and the run's summary sentence exactly as
 * the service wrote it (facts only).
 *
 * Each conflict shows the service's label. A per-student Must rule's item
 * names its students in `people` (one rule's students on one line), and its
 * label is then the rule part alone: the names are set in bold before it
 * ("Ana Ruiz, Ben Osei and Cleo Park", or "Ana Ruiz and Ben Osei; Cleo Park
 * and Dev Rao" for pairs, from `corePeopleText`), and the label is never taken
 * apart. Then, for an option: who closed it and since
 * which run, and the option's typed note as that run had it. Each links to its
 * Setup row (`#q-…`, `#opt-…`, `#pin-…`, `#nr`, `#shape`, from
 * `coreLinkHash`); an item that points nowhere has no link.
 *
 * Presentational: the route passes the run, the viewer, the Setup path, and
 * any runline actions as children.
 */

export type CantSolveRun = RunlineRun & Pick<RunViewModel, 'core' | 'summary'>;

export interface CantSolveViewProps {
  run: CantSolveRun;
  /** The viewer's user id: "You closed it before run 6". */
  viewerId: string;
  /** The set's Setup tab (`paths.set`); links add the row's hash. */
  setupPath: string;
  /** Runline actions. */
  children?: ReactNode;
}

/** "You closed it before run 6 · "Pitcher dropped the class"" — provenance, then the typed note. */
function optionLine(item: CoreItem, viewerId: string): string | null {
  const option = item.option;
  if (!option) return null;
  const parts = [
    option.closed ? closedProvenanceText(option.closed, viewerId) : null,
    option.note ? quoted(option.note) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function CoreRow({
  item,
  viewerId,
  setupPath,
}: {
  item: CoreItem;
  viewerId: string;
  setupPath: string;
}) {
  const names = corePeopleText(item);
  const line = optionLine(item, viewerId);
  const hash = coreLinkHash(item.link);
  const linkLabel = coreLinkLabel(item.link);

  return (
    <li data-core={item.kind} className="pl-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 text-gray-900 dark:text-gray-100">
          {names ? (
            <>
              <b className="font-semibold">{names}</b>
              {' · '}
            </>
          ) : null}
          {item.label}
        </span>
        {hash && linkLabel ? (
          <Link
            to={{ pathname: setupPath, hash }}
            className="whitespace-nowrap text-xs font-semibold text-blue-700 hover:underline dark:text-blue-300"
          >
            {linkLabel}
          </Link>
        ) : null}
      </div>
      {line ? <div className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{line}</div> : null}
    </li>
  );
}

export function CantSolveView({ run, viewerId, setupPath, children }: CantSolveViewProps) {
  return (
    <div className="grid gap-3">
      <Runline run={run}>{children}</Runline>
      {run.core.length > 0 || run.summary ? (
        <section
          aria-labelledby="cant-solve-title"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3.5 dark:border-rose-900 dark:bg-rose-950/40"
        >
          <h3
            id="cant-solve-title"
            className="text-sm font-semibold text-rose-900 dark:text-rose-100"
          >
            {cantSolveHeading()}
          </h3>
          {run.core.length > 0 ? (
            <>
              <p className="mt-0.5 text-sm text-rose-900 dark:text-rose-200">{cantSolveIntro()}</p>
              <ol className="mt-2.5 grid list-decimal gap-2 pl-5 text-sm marker:text-rose-700 dark:marker:text-rose-300">
                {run.core.map((item, index) => (
                  <CoreRow
                    key={`${index}-${item.src}`}
                    item={item}
                    viewerId={viewerId}
                    setupPath={setupPath}
                  />
                ))}
              </ol>
            </>
          ) : null}
          {run.summary ? (
            <p
              data-testid="cant-solve-summary"
              className={`text-sm text-rose-900 dark:text-rose-200 ${
                run.core.length > 0 ? 'mt-3' : 'mt-0.5'
              }`}
            >
              {run.summary}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export default CantSolveView;
