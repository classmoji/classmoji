import type { ReactNode, Ref } from 'react';

import type { PlacementFacts } from './types.ts';
import { personName, TEAMS_LABELS, whyLines, type WhyLine } from './teamsView.ts';

/**
 * Results: why the chosen person is where they are — facts only, in the order
 * `whyLines` gives them: their team and mates, what they pitched, pins that
 * name them, where the previous run put them, Shifts-priority answers, the
 * didn't-answer line, higher picks, their requests, their own notes.
 *
 * Nothing here says anything about identity: PlacementFacts has no identity
 * field, and this panel renders only what `whyLines` returns. The pin block
 * comes in as `children`, under the facts.
 *
 * The facts are a polite live region, so choosing another person reads their
 * facts out; the pin block is outside it (typing a reason is not news).
 */

export interface WhyPanelProps {
  /** The chosen person's facts; null = nobody chosen (only the title shows). */
  facts: PlacementFacts | null;
  viewerId: string;
  /** The panel itself, for the route to scroll it into view. */
  ref?: Ref<HTMLElement>;
  /** The pin block for this person. */
  children?: ReactNode;
}

function Line({ line }: { line: WhyLine }) {
  switch (line.kind) {
    case 'higher_picks':
      return (
        <div data-why={line.kind}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {line.text}
          </div>
          <ol className="mt-1 grid list-decimal gap-1 pl-5">
            {(line.items ?? []).map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </div>
      );
    case 'note':
      return (
        <figure data-why={line.kind} className="m-0">
          {line.items?.[0] ? (
            <figcaption className="text-xs text-gray-500 dark:text-gray-400">
              {line.items[0]}
            </figcaption>
          ) : null}
          <blockquote className="m-0 border-l-[3px] border-amber-300 pl-2.5 italic text-gray-700 dark:border-amber-700 dark:text-gray-300">
            {line.text}
          </blockquote>
        </figure>
      );
    default:
      return (
        <p data-why={line.kind} className="m-0">
          {line.text}
        </p>
      );
  }
}

export function WhyPanel({ facts, viewerId, ref, children }: WhyPanelProps) {
  const lines = facts ? whyLines(facts, viewerId) : [];

  return (
    <aside
      ref={ref}
      aria-labelledby="why-title"
      className="scroll-mt-3 self-start rounded-xl border border-gray-200 bg-white lg:sticky lg:top-3 dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="rounded-t-xl border-b border-gray-200 bg-gray-50 px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800/60">
        <h3 id="why-title" className="text-sm font-semibold text-gray-900 dark:text-white">
          {TEAMS_LABELS.whyTitle}
        </h3>
      </div>
      {facts ? (
        <div
          data-user-id={facts.user_id}
          className="grid gap-2.5 px-4 py-3 text-sm text-gray-700 dark:text-gray-300"
        >
          <div data-testid="why-facts" aria-live="polite" className="grid gap-2.5">
            <h4 className="text-[15px] font-semibold text-gray-900 dark:text-white">
              {personName(facts)}
            </h4>
            {lines.map((line, index) => (
              <Line key={`${line.kind}-${index}`} line={line} />
            ))}
          </div>
          {children}
        </div>
      ) : null}
    </aside>
  );
}

export default WhyPanel;
