// Re-export from the admin route: the create/edit drawer. It exports no action
// of its own — it posts to the parent quizzes route, which carries the gate.
export { loader, default } from '../admin.$class.quizzes.form/route';
