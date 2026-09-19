// Re-export from the admin route, whose loader allows ['OWNER', 'TEACHER'] and
// then redirects into the forms subtree in apps/pages. It exports no action.
//
// Without this file the Forms nav entry — which lists TEACHER among its roles —
// would 404 for every teacher, because CommonLayout builds nav links from the
// role's own prefix (`/teacher/:class/forms`). Same shape as
// `teacher.$class_.pages.$pageId`.
export { loader, default } from '../admin.$class.forms.$/route';
