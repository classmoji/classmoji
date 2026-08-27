// Re-export from the admin route: its loader and action both already allow
// ['OWNER', 'TEACHER'].
export { loader, action, default } from '../admin.$class.resources/route';
