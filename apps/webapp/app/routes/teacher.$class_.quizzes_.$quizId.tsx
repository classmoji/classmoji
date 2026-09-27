// Re-export from the admin quiz detail route. Both its loader and its action
// now list ['OWNER', 'TEACHER', 'ASSISTANT'], and both answer 404 where the
// classroom's quizzes are hidden.
export { loader, action, default } from './admin.$class.quizzes_.$quizId';
