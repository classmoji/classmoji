// Re-export from the admin route, whose loader allows ['OWNER', 'TEACHER'] and
// then redirects into the pages editor app. It exports no action.
export { loader, default } from '../admin.$class.pages.$pageId/route';
