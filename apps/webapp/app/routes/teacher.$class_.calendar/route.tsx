// Re-export from the ADMIN calendar, not the assistant one. Both variants gate
// on ['OWNER', 'TEACHER', 'ASSISTANT'] and both now restrict event creation to
// OFFICE_HOURS for an ASSISTANT; they differ in the UI they render and in who
// may edit an event they did not create. The admin variant derives `isAdmin`
// from ['OWNER', 'TEACHER'] and applies the office-hours limit only to callers
// outside that set, so a TEACHER gets the unrestricted calendar — which is what
// the server's TEACHER policy actually is, and why this is the variant exposed
// here.
export { loader, action, default } from '../admin.$class.calendar/route';
