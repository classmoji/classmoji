// Re-export from the admin route — the quiz management list, mirroring the
// teacher prefix. Its loader and action both list
// ['OWNER', 'TEACHER', 'ASSISTANT'], so this prefix serves exactly the roles
// they already admit; the Pro-tier and quizzes_enabled gates in front of them
// are unchanged and still apply here.
//
// This replaces the student-facing quiz list that used to be served here. That
// view is unchanged and still reachable at /student/:class/quizzes, whose own
// gate lists ASSISTANT.
export { loader, action, default } from '../admin.$class.quizzes/route';
