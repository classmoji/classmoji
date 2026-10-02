import { ClassmojiService } from '@classmoji/services';
import { withHiddenRows } from '@classmoji/utils';
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
 * `withoutQuizRows` in a classroom that does not show quizzes. Legacy QUIZ
 * items are left out either way: a quiz sits in a module through its
 * assignment now, and the item ordering ignores them.
 *
 * Deleting a module that owns any assignment is refused, except that in a
 * classroom without quizzes a module whose only assignments are quiz ones is
 * deleted with them (the owner cannot see them). `hasUnlistedAssignments`
 * says when the module owns assignments the page does not list besides those
 * — the page then offers no Delete, since moving the listed ones could never
 * unblock it. It says nothing more: not which rows, what they are or how many.
 */
export const forStaffPage = <
  M extends { items: Array<{ item_type: string }>; assignments: Array<{ type: string }> },
>(
  module: M,
  quizzesVisible: boolean
): M & { hasUnlistedAssignments: boolean } => {
  if (quizzesVisible) {
    return {
      ...module,
      items: module.items.filter(item => item.item_type !== 'QUIZ'),
      hasUnlistedAssignments: false,
    };
  }
  const listed = withoutQuizRows(module);
  const onlyHiddenQuizzes = listed.assignments.length === 0;
  return {
    ...listed,
    hasUnlistedAssignments:
      !onlyHiddenQuizzes && listed.assignments.length < module.assignments.length,
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

/** Whether this classroom hides quizzes, for `module.deleteById`'s quiz-only case. */
export const quizzesHiddenIn = async (classroomId: string): Promise<boolean> =>
  !(await loadQuizzesVisible(classroomId));

// `withHiddenRows` puts the rows the page never saw back into an ordering it
// sent. It lives in @classmoji/utils, shared with the MCP's module_reorder.
export { withHiddenRows };

// The reorder and move services take a module's FULL list and refuse a short
// one. Without quizzes the page lists no quiz rows, so the list it sends needs
// the module's hidden quiz rows added back before it reaches them.

/**
 * The full content-item order for `moduleId`, from the order the page sent.
 * Legacy QUIZ (and REPOSITORY) items are not in the content list the page
 * shows or the service orders, so the page's list is already complete.
 */
export const fullItemOrder = async (
  _classroomId: string,
  _moduleId: string,
  orderedItemIds: string[]
): Promise<string[]> => orderedItemIds;

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
