/**
 * This browser's IANA time zone, or null where it cannot be read.
 *
 * CLIENT-SIDE, and called at submit time (never during render, where the server
 * has no browser). Whatever it returns is a suggestion: every server that
 * receives it validates it against Intl and ignores an invalid value.
 * Used to seed a new classroom's time zone and as Ask Moji's fallback when the
 * classroom has none.
 */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
