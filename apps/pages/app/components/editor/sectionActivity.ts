/**
 * The editor's staff chips, without React: "Unlocked by X of Y" on a locked
 * section, "Done by X of Y" on a checkable heading, and the list each one
 * opens (`GET /api/page-sections`). Kept apart from the components so the
 * unit suite can drive it directly.
 */

/** `unlock`: who opened a locked section; `check`: who ticked a checkable heading. */
export type SectionActivityKind = 'unlock' | 'check';

interface ActivityCopy {
  /** The chip and the list header: "<label> X of Y". */
  label: string;
  emptyTitle: string;
  emptyText: string;
}

export const ACTIVITY_COPY: Readonly<Record<SectionActivityKind, ActivityCopy>> = Object.freeze({
  unlock: {
    label: 'Unlocked by',
    emptyTitle: 'No unlocks yet',
    emptyText: 'Students who unlock this section appear here.',
  },
  check: {
    label: 'Done by',
    emptyTitle: 'No one yet',
    emptyText: 'Students who mark this section done appear here.',
  },
});

/** The counts a chip reads (`sectionStats` from the page loader). */
export interface ActivityCounts {
  students: number;
  unlocks: Record<string, number>;
  checks: Record<string, number>;
}

/** How many current students unlocked / ticked this block (own keys only; 0 when absent). */
export function activityCount(
  stats: ActivityCounts,
  kind: SectionActivityKind,
  blockId: string
): number {
  const counts = kind === 'unlock' ? stats.unlocks : stats.checks;
  if (!counts || !Object.prototype.hasOwnProperty.call(counts, blockId)) return 0;
  const value = counts[blockId];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** "Unlocked by 3 of 20" / "Done by 3 of 20". */
export function activityLabel(kind: SectionActivityKind, count: number, students: number): string {
  return `${ACTIVITY_COPY[kind].label} ${count} of ${students}`;
}

/** The list's URL for one block. */
export function activityListUrl(
  pageId: string,
  blockId: string,
  kind: SectionActivityKind
): string {
  return `/api/page-sections?${new URLSearchParams({ pageId, blockId, kind })}`;
}

/** One student in the list; `at` is when they unlocked or ticked. */
export interface ActivityPerson {
  userId: string;
  name: string | null;
  login: string | null;
  avatarUrl: string | null;
  at: string;
}

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The GET answer as `{ students, people }`, newest first. Reads `unlocks[]`
 * with `unlockedAt` or `checks[]` with `checkedAt`; rows without a user id or
 * a time are dropped.
 */
export function parseActivityList(
  kind: SectionActivityKind,
  body: unknown
): { students: number; people: ActivityPerson[] } {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const rows = record[kind === 'unlock' ? 'unlocks' : 'checks'];
  const timeKey = kind === 'unlock' ? 'unlockedAt' : 'checkedAt';
  const people: ActivityPerson[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const userId = stringOrNull(row.userId);
    const at = stringOrNull(row[timeKey]);
    if (!userId || !at) continue;
    people.push({
      userId,
      name: stringOrNull(row.name),
      login: stringOrNull(row.login),
      avatarUrl: stringOrNull(row.avatarUrl),
      at,
    });
  }
  people.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const students = typeof record.students === 'number' ? record.students : 0;
  return { students, people };
}

/**
 * Is this answer "that block is not a section in the saved page"? The GET's
 * 400 for a heading made checkable (or a section added) in the editor and not
 * yet in the version students read: no one can have acted on it, so the list
 * is empty rather than failed.
 */
export function isNoSuchSection(status: number, body: unknown): boolean {
  return (
    status === 400 &&
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'NO_SUCH_SECTION'
  );
}
