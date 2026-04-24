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
    background: '#EDEDED',
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

export const getThemeByKey = (key: string | null | undefined): ClassroomTheme => {
  return (
    CLASSROOM_THEMES.find(t => t.key === key) ??
    CLASSROOM_THEMES.find(t => t.key === DEFAULT_CLASSROOM_THEME)!
  );
};
