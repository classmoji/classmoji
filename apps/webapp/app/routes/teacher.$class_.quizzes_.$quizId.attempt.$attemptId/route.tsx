// Re-export from the admin route: an instructor viewing a student's attempt.
// Its loader now lists ['OWNER', 'TEACHER', 'ASSISTANT']. It exports no action.
export { loader, default } from '../admin.$class.quizzes_.$quizId.attempt.$attemptId/route';
