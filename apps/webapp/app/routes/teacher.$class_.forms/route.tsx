// Re-export from the admin route, whose loader AND action both gate on
// ['OWNER', 'TEACHER'] — so `action` comes across too. Withholding it would
// leave the status select and the delete button posting to a route with no
// action under this prefix: the controls would render and silently do nothing.
//
// This file is what makes the Forms nav entry real for a teacher. CommonLayout
// builds nav links from the role's own prefix, and `/admin/:class/**` carries an
// owner-only layout loader, so a teacher must have their own route to land on.
//
// Deep links (`/teacher/:class/forms/:slug/edit` and friends) are a separate
// route, `teacher.$class_.forms_.$`, which redirects into apps/pages.
export { loader, action, default } from '../admin.$class.forms/route';
