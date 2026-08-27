// Re-export from the admin route — the page CMS list, not the student reader.
// Both its loader and its action already allow ['OWNER', 'TEACHER'], so the
// whole surface is exposed here; nothing about the gate changed, only the
// prefix it can be reached on. The component builds its links from the prefix
// in the URL, so they stay inside /teacher.
export { loader, action, default } from '../admin.$class.pages/route';
