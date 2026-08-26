// Re-export from the admin route: the loader is gated by
// requireClassroomTeachingTeam, which TEACHER passes. It exports no action.
export { loader, default } from '../admin.$class.submissions.$id/route';
