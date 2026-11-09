// Re-export from the admin route: the gradebook's submission panel. Its loader
// is OWNER+TEACHER (requireClassroomStaff), so this prefix serves exactly the
// roles it admits. It exports no action.
export { loader, default } from '../admin.$class.grades.submissions.$submissionId/route';
