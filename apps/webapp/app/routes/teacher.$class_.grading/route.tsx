// Re-export from the assistant route: the loader is gated by
// requireClassroomTeachingTeam, which TEACHER passes. The `action` is the same
// ungated stub the assistant prefix already exposes at this tier.
export { loader, action, default } from '../assistant.$class_.grading/route';
