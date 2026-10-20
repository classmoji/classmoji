// Re-export from the admin route: the Ask Moji insights page. Its loader is
// gated on OWNER or TEACHER of the classroom (./insights.server.ts there) and
// answers 404 where Ask Moji is not available. The page has no action.
export { loader, default } from '../admin.$class.ask-moji/route';
