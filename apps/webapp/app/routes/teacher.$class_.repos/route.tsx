// Re-export from the assistant route: the loader is gated by
// requireClassroomTeachingTeam, which TEACHER passes. It exports no action.
export { loader, default } from '../assistant.$class_.repos/route';
