// Re-export from the admin route — the quiz management list, since managing
// quizzes is the point of granting this role the surface. Its loader and action
// now list ['OWNER', 'TEACHER', 'ASSISTANT']; the Pro-tier and quizzes_enabled
// gates in front of them are unchanged and still apply here.
export { loader, action, default } from '../admin.$class.quizzes/route';
