import { ClassmojiService } from '@classmoji/services';
import { loadQuizzesVisible } from '~/utils/classroomProFlag.server';

/**
 * A module as the staff modules loaders hand it over, without its quiz items
 * and quiz assignments. A classroom that does not show quizzes (not Pro, or
 * switched off) gets this in place of the module, so no row, count or link on
 * the page can mention one. The stored rows are untouched.
 */
export const withoutQuizRows = <
  M extends { items: Array<{ item_type: string }>; assignments: Array<{ type: string }> },
>(
  module: M
): M => ({
  ...module,
  items: module.items.filter(item => item.item_type !== 'QUIZ'),
  assignments: module.assignments.filter(a => a.type !== 'QUIZ'),
});

/**
 * A module as the admin modules loaders hand it over: as stored, or
 * `withoutQuizRows` in a classroom that does not show quizzes. Deleting a
 * module that owns any assignment is refused, so `hasUnlistedAssignments` says
 * when the module owns assignments the page does not list — the page then
 * offers no Delete, since moving the listed ones could never unblock it. It
 * says nothing more: not which rows, what they are or how many.
 */
export const forStaffPage = <
  M extends { items: Array<{ item_type: string }>; assignments: Array<{ type: string }> },
>(
  module: M,
  quizzesVisible: boolean
): M & { hasUnlistedAssignments: boolean } => {
  if (quizzesVisible) return { ...module, hasUnlistedAssignments: false };
  const listed = withoutQuizRows(module);
  return {
    ...listed,
    hasUnlistedAssignments: listed.assignments.length < module.assignments.length,
  };
};

/**
 * Whether `moduleId` owns assignments the page does not list, for the copy of
 * a refused delete: the page offers no Delete for such a module, so one refused
 * on a page loaded before that changed gets a line that names none.
 */
export const ownsUnlistedAssignments = async (
  classroomId: string,
  moduleId: string
): Promise<boolean> => {
  if (await loadQuizzesVisible(classroomId)) return false;
  const module = await ClassmojiService.module.listModuleContents(moduleId, classroomId);
  return Boolean(module?.assignments.some(a => a.type === 'QUIZ'));
};

/**
 * An ordering the page sent, with the rows it never saw put back. Each hidden
 * row the list does not name follows the row it follows now — the nearest
 * earlier row the page did send — and one with no such row stays at the front.
 * Anchoring to a row rather than an index is what keeps a trailing hidden row
 * last when a move inserts a row above it. Hidden rows sharing an anchor keep
 * their current order. A visible row the page left out is not added back: the
 * services refuse that list, as they would without the hidden rows.
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

// The reorder and move services take a module's FULL list and refuse a short
// one. Without quizzes the page lists no quiz rows, so the list it sends needs
// the module's hidden quiz rows added back before it reaches them.

/** The full content-item order for `moduleId`, from the order the page sent. */
export const fullItemOrder = async (
  classroomId: string,
  moduleId: string,
  orderedItemIds: string[]
): Promise<string[]> => {
  if (await loadQuizzesVisible(classroomId)) return orderedItemIds;
  const module = await ClassmojiService.module.listModuleContents(moduleId, classroomId);
  if (!module) return orderedItemIds;
  return withHiddenRows(
    module.items
      .filter(item => item.item_type !== 'REPOSITORY')
      .map(item => ({ id: item.id, hidden: item.item_type === 'QUIZ' })),
    orderedItemIds
  );
};

/** The full assignment order for `moduleId`, from the order the page sent. */
export const fullAssignmentOrder = async (
  classroomId: string,
  moduleId: string,
  orderedAssignmentIds: string[]
): Promise<string[]> => {
  if (await loadQuizzesVisible(classroomId)) return orderedAssignmentIds;
  const module = await ClassmojiService.module.listModuleContents(moduleId, classroomId);
  if (!module) return orderedAssignmentIds;
  return withHiddenRows(
    module.assignments.map(a => ({ id: a.id, hidden: a.type === 'QUIZ' })),
    orderedAssignmentIds
  );
};
