/**
 * Classroom canvas themes.
 *
 * PURE MODULE — no imports, no Node, no DOM. It lives in @classmoji/utils
 * rather than in the webapp because two apps now need it: the webapp shell
 * (`CommonLayout`) tints its canvas from `ClassroomSettings.theme`, and the
 * public forms fill pages in apps/pages must carry that same tint so a
 * waitlist link looks like the course it belongs to.
 *
 * Reach it through the package SUBPATH `@classmoji/utils/themes`, never the
 * package root: the root barrel pulls in `roomStateStore` and `processSafety`,
 * which are not things a browser bundle should be made to carry for the sake of
 * five hex codes. `apps/webapp/app/constants/themes.ts` re-exports this file, so
 * every existing webapp call site is unchanged.
 *
 * Adding a theme means adding an entry here — a light `background` and the
 * `darkBackground` that replaces it under `prefers-color-scheme: dark`. Both are
 * required: a theme with only a light value renders as an unreadable white slab
 * for half the users.
 */

export interface ClassroomTheme {
  key: string;
  label: string;
  background: string;
  darkBackground: string;
}

export const CLASSROOM_THEMES: ClassroomTheme[] = [
  {
    key: 'classic',
    label: 'Classic',
    background: '#e8eef6',
    darkBackground: '#1a1a1a',
  },
  {
    key: 'stone',
    label: 'Stone',
    background: '#FDFDFD',
    darkBackground: '#1d1d1d',
  },
  {
    key: 'lavender',
    label: 'Lavender',
    background: '#F7F1F9',
    darkBackground: '#1c1a1f',
  },
  {
    key: 'sand',
    label: 'Sand',
    background: '#F6F0EC',
    darkBackground: '#1e1c1a',
  },
  {
    key: 'peach',
    label: 'Peach',
    background: '#F8EFEF',
    darkBackground: '#1f1c1c',
  },
];

export const DEFAULT_CLASSROOM_THEME = 'stone';

/**
 * The theme a key names, or the default. Never null: every caller is picking a
 * background colour and has nothing sensible to do with "no theme".
 */
export const getThemeByKey = (key: string | null | undefined): ClassroomTheme => {
  return (
    CLASSROOM_THEMES.find(t => t.key === key) ??
    CLASSROOM_THEMES.find(t => t.key === DEFAULT_CLASSROOM_THEME)!
  );
};
