export interface ModuleCard {
  /** Stable identifier (module id). */
  id: string;
  /** Slug or title used in the URL. */
  slug: string;
  /** Sequential display index (1-based). */
  number: number;
  /** Display name. */
  name: string;
  /** Formatted weeks range e.g. "1–2". Use "—" when unknown. */
  weeks: string;
  /** Percent complete 0–100. */
  pct: number;
  /** Count of completed items. */
  done: number;
  /** Total items. */
  total: number;
  /** Full link to the module detail view (role-aware). */
  href: string;
}
