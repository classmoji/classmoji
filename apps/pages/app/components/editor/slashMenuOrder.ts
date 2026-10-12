/**
 * The order of the editor's slash menu.
 *
 * Items are grouped (BlockNote draws a heading per group, so a group must be
 * contiguous) in `SLASH_MENU_GROUP_ORDER`; groups not listed follow, sorted by
 * name. Inside a group the incoming order is kept (the sort is stable).
 *
 * An item with `placeAfter` then moves to sit directly after the item whose
 * `key` matches: the checkable headings follow their plain counterparts
 * (Heading 1, Checkable heading 1, Heading 2, ...). BlockNote's default items
 * carry their dictionary key at runtime (`heading`, `heading_2`, ...) even
 * though `DefaultReactSuggestionItem` leaves it out of the type. An item whose
 * anchor is missing stays where the sort put it.
 */

export const SLASH_MENU_GROUP_ORDER = [
  'Headings',
  'Basic blocks',
  'Code',
  'Lists',
  'Media',
  'Advanced',
  'Subheadings',
  'Others',
];

export interface SlashMenuOrderEntry {
  title: string;
  group?: string;
  /** Key of the item this one is listed directly after. */
  placeAfter?: string;
}

const keyOf = (item: object): unknown => (item as { key?: unknown }).key;

export function arrangeSlashMenuItems<T extends SlashMenuOrderEntry>(items: readonly T[]): T[] {
  const rank = (group: string | undefined) => {
    const index = SLASH_MENU_GROUP_ORDER.indexOf(group || 'Others');
    return index === -1 ? SLASH_MENU_GROUP_ORDER.length : index;
  };
  const sorted = [...items].sort((a, b) => {
    const byRank = rank(a.group) - rank(b.group);
    if (byRank !== 0) return byRank;
    // Both outside the listed groups: alphabetical by group name.
    if (rank(a.group) === SLASH_MENU_GROUP_ORDER.length) {
      return (a.group || 'Others').localeCompare(b.group || 'Others');
    }
    return 0;
  });

  for (const item of items) {
    if (!item.placeAfter) continue;
    const anchor = sorted.findIndex(other => keyOf(other) === item.placeAfter);
    if (anchor === -1) continue;
    sorted.splice(sorted.indexOf(item), 1);
    const at = sorted.findIndex(other => keyOf(other) === item.placeAfter);
    sorted.splice(at + 1, 0, item);
  }
  return sorted;
}
