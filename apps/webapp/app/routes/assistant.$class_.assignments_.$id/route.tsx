// Re-export from the admin route: its loader and action are gated by
// requireClassroomTeachingTeam, which ASSISTANT passes. The action refuses
// grader changes from assistants; grading itself goes through the API route.
export { loader, action, default } from '../admin.$class.assignments_.$id/route';
