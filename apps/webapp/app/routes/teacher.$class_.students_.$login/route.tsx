// Re-export from the admin route: the one-student report. Its loader and
// action are gated by requireClassroomStaff (OWNER, TEACHER), and the school
// id edit inside the action is further limited to the owner.
export { loader, action, default } from '../admin.$class.students_.$login/route';
