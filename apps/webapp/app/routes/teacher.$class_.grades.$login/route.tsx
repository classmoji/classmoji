// Re-export from the admin route: the per-student comment drawer. Its loader
// and action both list ['OWNER', 'TEACHER'], so the action comes across too.
export { loader, action, default } from '../admin.$class.grades.$login/route';
