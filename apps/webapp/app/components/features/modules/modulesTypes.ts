export type ModuleState = 'done' | 'prog' | 'lock';

export interface ModuleCard {
  /** Stable identifier (module id). */
  id: string;
  /** Slug or title used in the URL. */
  slug: string;
  /** Sequential display index (1-based). */
  number: number;
  /** Display name. */
  name: string;
  /** Formatted weeks range e.g. "Week 1" or "Week 3-4". */
  weeks: string;
  /** Percent complete 0–100. */
  pct: number;
  /** Count of completed items. */
  done: number;
  /** Total items. */
  total: number;
  /** Sub-line meta: "X assignments · Y items · Z%". */
  subtitle: string;
  /** Status of this module (done/in-progress/locked). */
  state: ModuleState;
  /** Short meta line describing latest activity. */
  meta: string;
  /** Relative timestamp string (e.g. "2d ago"). */
  timestamp: string;
  /** Full link to the module detail view (role-aware). */
  href: string;
}
