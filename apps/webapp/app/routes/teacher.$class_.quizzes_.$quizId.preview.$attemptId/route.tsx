// Re-export from the admin route: previewing a quiz as an instructor. Its
// loader now lists ['OWNER', 'TEACHER', 'ASSISTANT']. It exports no action.
export { loader, default } from '../admin.$class.quizzes_.$quizId.preview.$attemptId/route';
