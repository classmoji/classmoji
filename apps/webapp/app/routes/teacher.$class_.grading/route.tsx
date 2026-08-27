// Re-export from the assistant route: the loader is gated by
// requireClassroomTeachingTeam, which TEACHER passes.
//
// No `action`: the source route has none. It previously carried an
// unauthenticated `() => ({ message: 'Success' })` stub that nothing posted to.
export { loader, default } from '../assistant.$class_.grading/route';
