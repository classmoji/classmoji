/**
 * Escape a value before it becomes a Resend template variable.
 *
 * Resend does NOT escape variable values — triple mustache is literal
 * injection, verified against the live API by passing `<b>x</b>` and watching
 * it render as markup. Every user-controlled string (student names, classroom
 * names, assignment titles, regrade comments) must go through this first, or a
 * student can inject HTML into a TA's inbox.
 */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, c => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return replacements[c] ?? c;
  });

/** Escape every value in a variables bag. Numbers pass through untouched. */
export const escapeVars = <T extends Record<string, string | number | null | undefined>>(
  vars: T
): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'number' ? value : escapeHtml(String(value));
  }
  return out;
};

/**
 * The app URL used in email links. `notificationEmails.ts` historically
 * defaulted to classmoji.com, which is wrong — the app is app.classmoji.io.
 */
export const appUrl = (): string => process.env.WEBAPP_URL ?? 'https://app.classmoji.io';

/**
 * The pages-service URL used in email links. Forms live in apps/pages, not the
 * webapp, so a form verification link points here — never at appUrl().
 */
export const pagesUrl = (): string => process.env.PAGES_URL ?? 'https://pages.classmoji.io';
