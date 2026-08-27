// Re-export from the admin route: both loader and action already allow
// ['OWNER', 'TEACHER'], so page creation is a right this role holds today.
export { loader, action, default } from '../admin.$class.pages.new/route';
