// Re-export from the admin route, whose loader allows ['OWNER', 'TEACHER'] and
// then redirects into the forms subtree in apps/pages. It exports no action.
//
// This is the DEEP-LINK half of Forms under /teacher. `/teacher/:class/forms`
// itself is now a real list in the webapp (`teacher.$class_.forms`); everything
// below it — `/forms/new`, `/forms/:slug/edit`, `/forms/:slug/responses` —
// still belongs to apps/pages and still arrives here to be handed over. The
// trailing underscore on `forms_` is what keeps the two apart: without it this
// splat would nest INSIDE the list route and render inside its Outlet instead
// of redirecting.
export { loader, default } from '../admin.$class.forms_.$/route';
