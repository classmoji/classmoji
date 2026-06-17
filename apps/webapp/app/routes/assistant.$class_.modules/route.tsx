// Re-export from the student route (already allows ASSISTANT in
// assertClassroomAccess, and shows unpublished modules/draft items to staff).
// Navigation paths are role-aware via useLocation().
export { loader, default } from '../student.$class.modules/route';
