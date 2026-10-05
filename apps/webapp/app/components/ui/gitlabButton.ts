/**
 * Gitlab's brand orange for the buttons that sign in with or connect Gitlab,
 * so they read as Gitlab beside Github's black and the app's green. The logo
 * is orange too, so on these buttons it is drawn white (GITLAB_BUTTON_LOGO).
 */

/** A plain <button>/<a> styled as the Gitlab button (add size and layout). */
export const GITLAB_BUTTON_COLORS =
  'bg-[#FC6D26] hover:bg-[#E85D17] text-white dark:bg-[#FC6D26] dark:hover:bg-[#FD8547] dark:text-white';

/** The same colours over an antd <Button> (its own styles need overriding). */
export const GITLAB_ANTD_BUTTON =
  'bg-[#FC6D26]! border-[#FC6D26]! text-white! hover:bg-[#E85D17]! hover:border-[#E85D17]! hover:text-white! dark:hover:bg-[#FD8547]! dark:hover:border-[#FD8547]!';

/** The Gitlab logo in white, for use on those buttons. */
export const GITLAB_BUTTON_LOGO = 'brightness-0 invert';
