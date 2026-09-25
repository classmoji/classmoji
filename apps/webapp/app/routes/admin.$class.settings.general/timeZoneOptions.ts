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
