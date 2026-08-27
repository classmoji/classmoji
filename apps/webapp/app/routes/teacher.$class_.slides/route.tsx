// Re-export from the admin route — the deck management view, not the student
// list. Both its loader and its action already allow ['OWNER', 'TEACHER'], so
// this is the variant that matches what the server actually grants this role.
export { loader, action, default } from '../admin.$class.slides/route';
