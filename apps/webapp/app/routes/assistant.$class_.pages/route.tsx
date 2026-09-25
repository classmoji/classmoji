// An assistant sees the same pages list the owner does, read-only: the status
// and the student-menu flag read as text, and each row opens the page to read
// it. Gone are New Page, Delete, and the controls that change a page's status
// or menu visibility.
//
// The loader is the admin one with ASSISTANT added to the roles it admits. It
// comes from a `.server` module rather than the admin ROUTE module: React
// Router only strips `loader`/`action`/`middleware`/`headers`, so a loader
// exported from a route file would drag its server-only imports into the client
// bundle. The ACTION is deliberately not re-exported — writes stay on /admin
// and /teacher.
import { teachingTeamLoader } from '../admin.$class.pages/loader.server';

export { default } from '../admin.$class.pages/route';

export const loader = teachingTeamLoader;
