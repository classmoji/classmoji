/**
 * One check for "can we mail this?", shared by registration, account settings
 * and sendEmailVerificationCode (#396). A syntactic sanity check, not RFC 5322:
 * it refuses strings Resend rejects as an invalid `to` (a bare username, a
 * number, a list, a display name) while accepting the addresses people really
 * have — plus-addressing, subdomains (mail.dartmouth.edu), multi-part TLDs
 * (.ac.uk) and non-ASCII (IDN) local parts and domains.
 */

export const INVALID_EMAIL_MESSAGE = 'Please enter a valid email address.';

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const MAX_LABEL_LENGTH = 63;

// Unquoted local part: letters/digits in any script plus the RFC atext
// symbols. Excludes whitespace, commas, angle brackets, quotes, parentheses,
// brackets, semicolons, colons, backslashes and a second '@'.
const LOCAL_RE = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~.-]+$/u;
// A domain label: letters/digits (any script), hyphens only inside.
const LABEL_RE = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u;
// The top-level label must not be all digits (rules out bare IPs like 1.2.3.4).
const TLD_RE = /[\p{L}]/u;

/** True when `email` (already trimmed) is shaped like a deliverable address. */
export const isValidEmail = (email: string): boolean => {
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > MAX_LOCAL_LENGTH || !LOCAL_RE.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every(label => label.length <= MAX_LABEL_LENGTH && LABEL_RE.test(label))) {
    return false;
  }
  return TLD_RE.test(labels[labels.length - 1]);
};

/**
 * Trim and lower-case a submitted address. Returns null when it is not a
 * string or not a valid address, so callers refuse it before touching the
 * verification table or the mailer. Lower case matches how user emails are
 * stored and how verification rows are keyed, so one mailbox has one code.
 */
export const normalizeEmail = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return isValidEmail(email) ? email : null;
};
