/**
 * An ordering a caller sent, with the rows it never saw put back.
 *
 * A reorder replaces every position of a list at once, so the services take
 * the FULL list and refuse a short one. A caller in a classroom that does not
 * show quizzes is never given the quiz rows (the Modules page and the MCP's
 * list_modules both leave them out), so the list it sends needs them added
 * back before it reaches a service.
 *
 * Each hidden row the list does not name follows the row it follows now — the
 * nearest earlier row the caller did send — and one with no such row stays at
 * the front. Anchoring to a row rather than an index is what keeps a trailing
 * hidden row last when a move inserts a row above it. Hidden rows sharing an
 * anchor keep their current order. A visible row the caller left out is not
 * added back: the services refuse that list, as they would without the hidden
 * rows.
 */
export const withHiddenRows = (
  current: Array<{ id: string; hidden: boolean }>,
  ordered: string[]
): string[] => {
  const given = new Set(ordered);
  // Hidden rows keyed by the sent row they follow; null is the front.
  const following = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const row of current) {
    if (given.has(row.id)) {
      anchor = row.id;
    } else if (row.hidden) {
      following.set(anchor, [...(following.get(anchor) ?? []), row.id]);
    }
  }
  const after = (id: string | null) => {
    const rows = following.get(id) ?? [];
    following.delete(id);
    return rows;
  };
  return [...after(null), ...ordered.flatMap(id => [id, ...after(id)])];
};
