// Re-export from the assistant route. Its loader reads at the teaching-team
// tier (requireClassroomTeachingTeam), which TEACHER already passes. The admin
// dashboard is NOT the source here: that one gates on requireClassroomAdmin,
// so it is OWNER-only and a teacher may not read it.
//
// No `action`: the source route has none. It previously carried an
// unauthenticated `() => ({ message: 'Success' })` stub that nothing posted to.
export { loader, default } from '../assistant.$class_.dashboard/route';
