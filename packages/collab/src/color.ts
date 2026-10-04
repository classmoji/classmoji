/**
 * A deterministic cursor/avatar colour for a user id, so every client shows
 * the same person in the same colour without coordinating. Mid-saturation
 * hues readable on both light and dark backgrounds.
 */
const PALETTE = [
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

export function userColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
