// Re-export from the assistant route: the loader and the quiz resolve action
// are gated by requireClassroomTeachingTeam, which TEACHER passes.
export { loader, action, default } from '../assistant.$class_.regrade-requests/route';
