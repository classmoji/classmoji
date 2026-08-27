// Re-export from the admin route — the quiz management list, mirroring the
// teacher prefix. Same loader, same action, same gates; this file adds no
// policy of its own, so anything true of the admin route is true here.
//
// This REPLACES the student-facing quiz list that used to be served at this
// path. An assistant no longer has a student-styled quiz view anywhere:
// /student/:class/quizzes nests under student.$class, whose loader is
// requireStudentAccess (STUDENT alone) and does not catch, so an assistant is
// refused at the layout before the quizzes leaf is reached. The old
// arrangement worked only because it pulled the student leaf into the
// assistant tree. Losing it is the intended trade — assistants gained the
// management screens, which carry their own preview.
export { loader, action, default } from '../admin.$class.quizzes/route';
