import { useEffect, useState } from 'react';
import dayjs from 'dayjs';

import { formCloseText, readinessParts } from './teamsView.ts';
import type { SetupView } from './types.ts';

/**
 * Setup's readiness strip: "24 on the roster · 21 answered · 3 haven't ·
 * Form closed Fri 26 Sep, 5:00 pm". Counts only.
 *
 * The close time is formatted after mount, in the browser's zone (the
 * builder's reason: the server's zone is not the viewer's, and formatting
 * during render is a hydration mismatch); until then that part is left out.
 *
 * Presentational: props in, nothing out.
 */

export interface ReadinessStripProps {
  /** SetupView.readiness. */
  readiness: SetupView['readiness'];
}

/** "Fri 26 Sep, 5:00 pm". */
const CLOSE_FORMAT = 'ddd D MMM, h:mm a';

/** "24 on the roster" → the count, set in bold, and the words after it. */
function splitCount(part: string): { count: string | null; rest: string } {
  const match = /^(\d+)(\s.*)$/.exec(part);
  return match ? { count: match[1], rest: match[2] } : { count: null, rest: part };
}

export function ReadinessStrip({ readiness }: ReadinessStripProps) {
  const closesAt = readiness.closes_at;
  const [closeTime, setCloseTime] = useState<string | null>(null);
  useEffect(() => {
    const parsed = closesAt ? dayjs(closesAt) : null;
    setCloseTime(parsed?.isValid() ? parsed.format(CLOSE_FORMAT) : null);
  }, [closesAt]);

  const parts = readinessParts(readiness);

  return (
    <div
      data-testid="setup-readiness"
      className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
    >
      {parts.map(part => {
        const { count, rest } = splitCount(part);
        return (
          <span key={part}>
            {count !== null ? (
              <b className="font-semibold tabular-nums text-gray-900 dark:text-white">{count}</b>
            ) : null}
            {rest}
          </span>
        );
      })}
      {closeTime ? (
        <span data-testid="setup-readiness-close">
          {formCloseText(readiness.closed, closeTime)}
        </span>
      ) : null}
    </div>
  );
}

export default ReadinessStrip;
