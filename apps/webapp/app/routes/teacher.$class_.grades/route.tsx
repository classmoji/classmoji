// Re-export from the admin route — the grades table. Its loader and action are
// both OWNER+TEACHER (requireClassroomStaff), so this prefix serves exactly the
// roles they admit. One intent inside the action is OWNER only: releasing or
// hiding final grades (`set-final-grades-released`) carries its own
// requireClassroomAdmin gate, so a teacher posting it here is refused.
export { loader, action, default } from '../admin.$class.grades/route';
