// Re-export from the admin route: one rated exchange, read-only, opened from
// the insights page. Same gate as the page (OWNER or TEACHER, 404 where Ask
// Moji is not available); no action.
export { loader, default } from '../admin.$class.ask-moji.$feedbackId/route';
