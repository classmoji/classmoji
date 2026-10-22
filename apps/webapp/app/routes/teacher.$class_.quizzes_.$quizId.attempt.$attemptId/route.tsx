// Re-export from the admin route: an instructor viewing a student's attempt.
// Its loader lists ['OWNER', 'TEACHER', 'ASSISTANT']; its action (adjust or
// revert the attempt's grade) is gated by requireClassroomTeachingTeam, which
// admits this role too (D5), and the service re-checks it.
export { loader, action, default } from '../admin.$class.quizzes_.$quizId.attempt.$attemptId/route';
