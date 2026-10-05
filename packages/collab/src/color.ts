/**
 * Cursor/avatar colours: mid-saturation hues readable on both light and dark
 * backgrounds.
 */
export const USER_COLORS = [
  '#e5484d', // red
  '#f76b15', // orange
  '#d6a000', // amber
  '#30a46c', // green
  '#12a594', // teal
  '#0090ff', // blue
  '#6e56cf', // violet
  '#d6409f', // pink
  '#8e4ec6', // purple
  '#3e63dd', // indigo
] as const;

/** The 31-hash both colour pickers start from. */
export function colorHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * A deterministic cursor/avatar colour for a user id, so every client shows
 * the same person in the same colour without coordinating.
 */
export function userColor(userId: string): string {
  const hash = colorHash(userId);
  return USER_COLORS[hash % USER_COLORS.length];
}
