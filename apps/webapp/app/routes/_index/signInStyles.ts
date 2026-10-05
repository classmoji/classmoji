/**
 * Shared look for the sign-in card. Theme tokens switch for dark mode on their own.
 * Buttons are 40px; fields are 32px, the app's control height (.btn and Antd's default).
 */

/** A sign-in option: Github, Gitlab, self-hosted Gitlab, email. */
export const optionButton =
  'inline-flex h-[40px] w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line-2 bg-panel px-3 text-sm font-medium text-ink-0 shadow-sm transition-colors duration-150 hover:border-line-strong hover:bg-panel-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 cursor-pointer disabled:cursor-default';

export const fieldClass =
  'h-[32px] w-full rounded-lg border border-line-2 bg-panel px-3 text-sm text-ink-0 placeholder:text-ink-4 transition-colors duration-150 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25';

export const labelClass = 'text-sm font-medium text-ink-1';

export const primaryButton =
  'mt-1 inline-flex h-[40px] w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-white transition-colors duration-150 hover:bg-accent-hover disabled:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 cursor-pointer disabled:cursor-default';

export const quietLink =
  'rounded-md text-xs font-medium text-ink-3 transition-colors duration-150 hover:text-ink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer';
