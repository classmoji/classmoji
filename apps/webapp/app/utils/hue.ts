/**
 * Deterministic hue in [0, 360) from a string — used for per-user / per-classroom accent.
 * Shared across sidebar, grading queue, roster, etc.
 */
export const hashHue = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 285;
  const str = String(value);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h % 360;
};

/**
 * Build initials from a name (e.g., "Alex Stein" -> "AS"). Falls back to a single
 * char from login/value when name is missing.
 */
export const getInitials = (name?: string | null, fallback?: string | null): string => {
  const source = (name || fallback || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
};
