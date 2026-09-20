// Re-export from the admin route: its loader and action are gated by
// requireClassroomTeachingTeam, which TEACHER passes; grader changes are
// further restricted to owners and teachers inside the action.
export { loader, action, default } from '../admin.$class.assignments_.$id/route';
