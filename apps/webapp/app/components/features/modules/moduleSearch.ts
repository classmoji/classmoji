/**
 * Search on the Modules page (staff and student views, #803).
 *
 * One rule for both: a query matches by title, case-insensitive substring.
 * - A module whose own title matches shows everything in it.
 * - Otherwise a module shows only the rows that match (assignments, pages,
 *   slide decks, forms, quizzes), and is hidden when none do.
 *
 * Each page supplies the titles its rows actually show, so a search finds what
 * the reader can see. Pure: no React, no data access.
 */

/** The query as it is matched: trimmed and lower-cased. Empty = not searching. */
export const normalizeModuleQuery = (query: string): string => query.trim().toLowerCase();

const includes = (text: string | null | undefined, q: string) =>
  !!text && text.toLowerCase().includes(q);

export interface ModuleSearchSubject<I, A> {
  title: string;
  items: I[];
  assignments: A[];
}

export interface ModuleSearchResult<I, A> {
  /** The module's own title matched: every row is shown. */
  wholeModule: boolean;
  items: I[];
  assignments: A[];
}

/**
 * What of `module` a search for `q` (already normalized) shows, or null when
 * nothing in it matches. With an empty `q`, everything.
 */
export function searchModule<I, A>(
  module: ModuleSearchSubject<I, A>,
  q: string,
  itemTitles: (item: I) => Array<string | null | undefined>,
  assignmentTitles: (assignment: A) => Array<string | null | undefined>
): ModuleSearchResult<I, A> | null {
  if (!q || includes(module.title, q)) {
    return { wholeModule: true, items: module.items, assignments: module.assignments };
  }
  const items = module.items.filter(item => itemTitles(item).some(t => includes(t, q)));
  const assignments = module.assignments.filter(a => assignmentTitles(a).some(t => includes(t, q)));
  if (items.length === 0 && assignments.length === 0) return null;
  return { wholeModule: false, items, assignments };
}
