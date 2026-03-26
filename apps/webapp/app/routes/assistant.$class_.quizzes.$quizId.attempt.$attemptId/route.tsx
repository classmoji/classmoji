// Re-export from student route (already allows ASSISTANT in assertClassroomAccess)
// Navigation paths are role-aware via useLocation()
export { loader, default } from '../student.$class.quizzes.$quizId.attempt.$attemptId/route';
