// Re-export from the assistant route. Its loader reads at the teaching-team
// tier (requireClassroomTeachingTeam), which TEACHER already passes. The admin
// dashboard is NOT the source here: that one gates on requireClassroomAdmin,
// so it is OWNER-only and a teacher may not read it.
//
// The `action` comes along because it is the same ungated stub the assistant
// prefix already exposes at this tier — it exists so a fetcher post has a
// target rather than a 405.
export { loader, action, default } from '../assistant.$class_.dashboard/route';
