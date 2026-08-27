// Member (not classroom) settings. Re-export from the student route, whose
// loader lists TEACHER in assertClassroomAccess. It exports no action.
export { loader, default } from '../student.$class.settings/route';
