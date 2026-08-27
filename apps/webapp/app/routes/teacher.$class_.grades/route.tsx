// Re-export from the admin route — the grades table. Its loader and action are
// both OWNER+TEACHER (requireClassroomStaff), so this prefix serves exactly the
// roles they admit.
export { loader, action, default } from '../admin.$class.grades/route';
