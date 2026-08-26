// Re-export from the ADMIN calendar, not the assistant one. Both variants gate
// on ['OWNER', 'TEACHER', 'ASSISTANT'], but they grant different rights: the
// assistant variant hardcodes an intent check that rejects any event type other
// than OFFICE_HOURS, while the admin variant derives `isAdmin` from
// ['OWNER', 'TEACHER'] and imposes no such limit. Unrestricted is what the
// server's TEACHER policy actually is, so that is the variant exposed here.
export { loader, action, default } from '../admin.$class.calendar/route';
