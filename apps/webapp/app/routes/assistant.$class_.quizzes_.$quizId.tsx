// Re-export from the admin quiz detail route. Both its loader and its action
// list ['OWNER', 'TEACHER', 'ASSISTANT'], behind the unchanged Pro-tier gate.
export { loader, action, default } from './admin.$class.quizzes_.$quizId';
