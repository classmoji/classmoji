import { useLayoutEffect } from 'react';

/**
 * The admin app follows the OS color scheme, nothing else: there is no Tweaks
 * panel here (the webapp's `useDarkMode` reads its `cm-tweaks` blob instead).
 * The accent stays the Classmoji green from tokens.css.
 *
 * Two halves, both needed:
 *
 * - THEME_SCRIPT runs in <head> before first paint, so a dark-mode visitor
 *   never sees a light frame while the bundle loads.
 * - useSystemTheme re-applies it after React commits, and follows OS changes.
 *   The script alone is not enough: when hydration fails (any server/client
 *   text mismatch, e.g. a date the Worker formats in UTC and the browser in
 *   the viewer's time zone), React 19 re-renders the whole document on the
 *   client and resets <html>'s attributes to the ones it rendered, dropping
 *   the `dark` class, and the inline script does not run again. A layout
 *   effect runs after that commit and before paint, so the page stays dark.
 */
const QUERY = '(prefers-color-scheme: dark)';

export const applyTheme = (isDark: boolean): void => {
  const root = document.documentElement;
  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  root.classList.toggle('dark', isDark);
};

export const THEME_SCRIPT = `
(function () {
  try {
    var isDark = window.matchMedia('${QUERY}').matches;
    var root = document.documentElement;
    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    root.classList.toggle('dark', isDark);
  } catch (e) {}
})();
`;

export const useSystemTheme = (): void => {
  useLayoutEffect(() => {
    const mq = window.matchMedia(QUERY);
    applyTheme(mq.matches);
    const onChange = (e: MediaQueryListEvent) => applyTheme(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
};
