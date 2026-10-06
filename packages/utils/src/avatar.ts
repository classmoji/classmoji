/**
 * The image the database extension hands out as `user.avatar_url` when the
 * user has no `image` of their own. It is a generic silhouette, not a picture
 * of anyone, so avatar components treat it the same as "no image" and draw the
 * user's initials instead (see `isPlaceholderAvatar`).
 */
export const DEFAULT_AVATAR_URL = 'https://cdn-icons-png.flaticon.com/512/25/25231.png';

/** True when `url` is missing or is only the generic default avatar. */
export const isPlaceholderAvatar = (url: string | null | undefined): boolean =>
  !url || url === DEFAULT_AVATAR_URL;
