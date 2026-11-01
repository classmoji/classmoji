// Re-export from the admin route: the gradebook CSV download. Its loader is
// OWNER+TEACHER (requireClassroomStaff), so this prefix serves exactly the roles
// it admits.
export { loader } from '../admin.$class.grades.export/route';
