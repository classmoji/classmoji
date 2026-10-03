/**
 * The course time-zone picker's options.
 *
 * `zones` comes from the LOADER (`listTimeZones()` on the server), never from
 * the browser's own Intl: the server validates and stores the canonical
 * spelling its ICU produces, and a browser whose ICU disagrees would render a
 * list that cannot select what was saved (and a hydration mismatch).
 *
 * The stored value is always carried through, even when it is not in the list
 * (set by an older release, an MCP call, or a different ICU), because an antd
 * Select whose value matches no option renders a bare string and looks broken.
 * Labels swap underscores for spaces; the IANA name is what is stored, so the
 * label stays honest about it.
 */
export interface TimeZoneOption {
  value: string;
  label: string;
}

export function timeZoneOptions(
  zones: readonly string[],
  current: string | null | undefined
): TimeZoneOption[] {
  const list = [...zones];
  const stored = (current ?? '').trim();
  if (stored && !list.includes(stored)) list.push(stored);
  return list.map(zone => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}

/** The zone Intl resolves `zone` to, or null when it cannot build a formatter. */
function resolved(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The OFFERED option (server spelling) that names the same zone as the
 * browser's, or null when none does.
 *
 * Browsers report the current IANA names (`Asia/Kolkata`, `Europe/Kyiv`) while
 * the server's ICU may list the older aliases (`Asia/Calcutta`, `Europe/Kiev`),
 * so a plain `includes` would never offer those users the shortcut. Both sides
 * are put through THIS runtime's Intl, which resolves an alias and its current
 * name to the same zone, and the option's own value is what gets selected.
 */
export function matchOfferedZone(
  zones: readonly string[],
  browserZone: string | null | undefined
): string | null {
  if (!browserZone) return null;
  if (zones.includes(browserZone)) return browserZone;
  const target = resolved(browserZone);
  if (!target) return null;
  return zones.find(zone => resolved(zone) === target) ?? null;
}
