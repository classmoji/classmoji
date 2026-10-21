import { ClassmojiService } from '@classmoji/services';

/**
 * The response for a refused lifecycle change, or null when `error` is not
 * one: the Free plan's one-active-class rule (with the plan owner's own active
 * classes, when the caller is the plan owner) or a class with no accepted
 * owner to count against.
 */
export const lifecycleRefusal = (error: unknown): Response | null => {
  if (ClassmojiService.classroomLifecycle.isActiveClassroomLimitError(error)) {
    return Response.json(
      { error: error.message, code: error.code, activeClassrooms: error.activeClassrooms },
      { status: 403 }
    );
  }
  if (
    error instanceof Error &&
    (error as { code?: unknown }).code === ClassmojiService.classroomLifecycle.NO_PLAN_OWNER
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  return null;
};
