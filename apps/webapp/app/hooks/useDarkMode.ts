import { useEffect, useState, useCallback } from 'react';

// Tweaks-aware dark mode + accent color hook.
// Reads/writes `cm-tweaks` from localStorage and applies the chosen theme +
// accent color (and derived tints) to the document root.

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Resolve a theme choice to the concrete light/dark value to apply to the DOM.
 * 'system' falls through to the OS-level prefers-color-scheme media query.
 */
function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export interface TweaksState {
  theme: ThemeMode;
  accent: string;
  background: BackgroundKey;
  uiFontSize: number;
  translucentSidebar: boolean;
  uiContrast: number;
  pointerCursors: boolean;
}

const STORAGE_KEY = 'cm-tweaks';
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_DEFAULT = 17;
export const CONTRAST_MIN = 0;
export const CONTRAST_MAX = 100;
export const CONTRAST_DEFAULT = 50;
const DEFAULT_TWEAKS: TweaksState = {
  theme: 'system',
  accent: '#0ea5e9',
  background: 'default',
  uiFontSize: FONT_SIZE_DEFAULT,
  translucentSidebar: false,
  uiContrast: CONTRAST_DEFAULT,
  pointerCursors: false,
};

export type BackgroundKey = 'default' | 'aurora' | 'mint' | 'peach' | 'slate' | 'dusk' | 'accent';

interface BgStops {
  s1: string;
  s2: string;
  s3a: string;
  s3b: string;
  s3c: string;
  paper: string;
  paper2: string;
  sidebar: string;
}

export interface BackgroundPreset {
  key: BackgroundKey;
  name: string;
  light: BgStops;
  dark: BgStops;
}

export const BACKGROUNDS: BackgroundPreset[] = [
  {
    key: 'default',
    name: 'Default',
    light: {
      s1: '#f7f9ff',
      s2: '#e6edfc',
      s3a: '#edf1fa',
      s3b: '#f3f6fc',
      s3c: '#ebf0fb',
      paper: '#f0f4fc',
      paper2: '#e8eef8',
      sidebar: '#ffffff',
    },
    dark: {
      s1: '#1a1f32',
      s2: '#0a0d17',
      s3a: '#0c0f1a',
      s3b: '#11152a',
      s3c: '#090b14',
      paper: '#0e1016',
      paper2: '#151824',
      sidebar: '#121521',
    },
  },
  {
    key: 'aurora',
    name: 'Aurora',
    light: {
      s1: '#ffd7e5',
      s2: '#ccd6ff',
      s3a: '#ece0ff',
      s3b: '#e7edff',
      s3c: '#ffdbe6',
      paper: '#fcf0f5',
      paper2: '#f4ebfb',
      sidebar: '#fef8fb',
    },
    dark: {
      s1: '#2e1536',
      s2: '#0a071e',
      s3a: '#120c24',
      s3b: '#1c1436',
      s3c: '#0a071c',
      paper: '#120c18',
      paper2: '#191127',
      sidebar: '#150e20',
    },
  },
  {
    key: 'mint',
    name: 'Mint',
    light: {
      s1: '#b9e7cc',
      s2: '#a8dec1',
      s3a: '#cfe8d8',
      s3b: '#dcecdf',
      s3c: '#b7d9c4',
      paper: '#e8f3ec',
      paper2: '#d9ebe1',
      sidebar: '#f2f8f4',
    },
    dark: {
      s1: '#123629',
      s2: '#061510',
      s3a: '#0c2118',
      s3b: '#102c22',
      s3c: '#04100b',
      paper: '#0a1812',
      paper2: '#0e2119',
      sidebar: '#0c1b14',
    },
  },
  {
    key: 'peach',
    name: 'Peach',
    light: {
      s1: '#ffcea1',
      s2: '#ffb589',
      s3a: '#ffdcbd',
      s3b: '#ffe4cc',
      s3c: '#ffc395',
      paper: '#fcebd8',
      paper2: '#f6dcbf',
      sidebar: '#fdf3e7',
    },
    dark: {
      s1: '#3b1f12',
      s2: '#160b07',
      s3a: '#1e1109',
      s3b: '#26160d',
      s3c: '#0f0805',
      paper: '#1a110a',
      paper2: '#261a10',
      sidebar: '#1d140c',
    },
  },
  {
    key: 'slate',
    name: 'Slate',
    light: {
      s1: '#d6dce6',
      s2: '#c3cbd9',
      s3a: '#d0d7e1',
      s3b: '#dde2eb',
      s3c: '#c6ccd8',
      paper: '#edf0f5',
      paper2: '#e0e5ee',
      sidebar: '#f5f7fa',
    },
    dark: {
      s1: '#21252f',
      s2: '#0a0c14',
      s3a: '#10131c',
      s3b: '#171a24',
      s3c: '#0a0b10',
      paper: '#0f1117',
      paper2: '#161a22',
      sidebar: '#111319',
    },
  },
  {
    key: 'dusk',
    name: 'Dusk',
    light: {
      s1: '#b4c3f0',
      s2: '#8fa3db',
      s3a: '#bcc7e7',
      s3b: '#c9d2ed',
      s3c: '#9dadd8',
      paper: '#dfe6f7',
      paper2: '#ced8ef',
      sidebar: '#ecf0fa',
    },
    dark: {
      s1: '#232a5a',
      s2: '#050825',
      s3a: '#0a1030',
      s3b: '#121a40',
      s3c: '#050720',
      paper: '#0c1029',
      paper2: '#131838',
      sidebar: '#0e1330',
    },
  },
  {
    key: 'accent',
    name: 'Accent',
    light: { s1: '', s2: '', s3a: '', s3b: '', s3c: '', paper: '', paper2: '', sidebar: '' },
    dark: { s1: '', s2: '', s3a: '', s3b: '', s3c: '', paper: '', paper2: '', sidebar: '' },
  },
];

function getBackgroundStops(key: BackgroundKey, theme: ThemeMode, accent: string): BgStops {
  if (key === 'accent') {
    if (theme === 'light') {
      return {
        s1: mix(accent, '#ffffff', 0.65),
        s2: mix(accent, '#ffffff', 0.55),
        s3a: mix(accent, '#ffffff', 0.78),
        s3b: mix(accent, '#ffffff', 0.86),
        s3c: mix(accent, '#ffffff', 0.72),
        paper: mix(accent, '#ffffff', 0.88),
        paper2: mix(accent, '#ffffff', 0.8),
        sidebar: mix(accent, '#ffffff', 0.94),
      };
    }
    return {
      s1: mix(accent, '#000000', 0.62),
      s2: mix(accent, '#000000', 0.88),
      s3a: mix(accent, '#000000', 0.84),
      s3b: mix(accent, '#000000', 0.76),
      s3c: mix(accent, '#000000', 0.92),
      paper: mix(accent, '#000000', 0.9),
      paper2: mix(accent, '#000000', 0.84),
      sidebar: mix(accent, '#000000', 0.88),
    };
  }
  const preset = BACKGROUNDS.find(b => b.key === key) ?? BACKGROUNDS[0];
  return theme === 'dark' ? preset.dark : preset.light;
}

interface AccentTints {
  hex: string;
  hover: string;
  soft: string;
  soft2: string;
  ink: string;
}

const ACCENTS: AccentTints[] = [
  { hex: '#6d5efc', hover: '#5a4cf0', soft: '#ece9ff', soft2: '#dedaff', ink: '#4a3fbb' },
  { hex: '#4f46e5', hover: '#4338ca', soft: '#e0e7ff', soft2: '#c7d2fe', ink: '#3730a3' },
  { hex: '#0ea5e9', hover: '#0284c7', soft: '#e0f2fe', soft2: '#bae6fd', ink: '#075985' },
  { hex: '#10b981', hover: '#059669', soft: '#d1fae5', soft2: '#a7f3d0', ink: '#065f46' },
  { hex: '#f59e0b', hover: '#d97706', soft: '#fef3c7', soft2: '#fde68a', ink: '#92400e' },
  { hex: '#f43f5e', hover: '#e11d48', soft: '#ffe4e6', soft2: '#fecdd3', ink: '#9f1239' },
  { hex: '#f97316', hover: '#ea580c', soft: '#ffedd5', soft2: '#fed7aa', ink: '#9a3412' },
  { hex: '#14b8a6', hover: '#0d9488', soft: '#ccfbf1', soft2: '#99f6e4', ink: '#115e59' },
  { hex: '#d946ef', hover: '#c026d3', soft: '#fae8ff', soft2: '#f5d0fe', ink: '#86198f' },
  { hex: '#475569', hover: '#334155', soft: '#e2e8f0', soft2: '#cbd5e1', ink: '#1e293b' },
  { hex: '#dc2626', hover: '#b91c1c', soft: '#fee2e2', soft2: '#fecaca', ink: '#7f1d1d' },
  { hex: '#84cc16', hover: '#65a30d', soft: '#ecfccb', soft2: '#d9f99d', ink: '#3f6212' },
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const expanded =
    h.length === 3
      ? h
          .split('')
          .map(c => c + c)
          .join('')
      : h;
  const n = parseInt(expanded, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mix(hex: string, withHex: string, amt: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(withHex);
  const r = Math.round(a.r + (b.r - a.r) * amt);
  const g = Math.round(a.g + (b.g - a.g) * amt);
  const bl = Math.round(a.b + (b.b - a.b) * amt);
  return '#' + [r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function deriveAccent(hex: string): AccentTints {
  const preset = ACCENTS.find(a => a.hex.toLowerCase() === hex.toLowerCase());
  if (preset) return preset;
  return {
    hex,
    hover: mix(hex, '#000000', 0.12),
    soft: mix(hex, '#ffffff', 0.84),
    soft2: mix(hex, '#ffffff', 0.72),
    ink: mix(hex, '#000000', 0.42),
  };
}

function deriveDarkTints(hex: string): { soft: string; soft2: string; ink: string } {
  return {
    soft: mix(hex, '#000000', 0.78),
    soft2: mix(hex, '#000000', 0.65),
    ink: mix(hex, '#ffffff', 0.5),
  };
}

export function applyTweaks({
  theme,
  accent,
  background,
  uiFontSize,
  translucentSidebar,
  uiContrast,
  pointerCursors,
}: TweaksState): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  root.setAttribute('data-theme', resolved);
  if (resolved === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');

  const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, uiFontSize));
  root.style.fontSize = clamped + 'px';

  if (translucentSidebar) root.classList.add('translucent-sidebar');
  else root.classList.remove('translucent-sidebar');

  const contrastClamped = Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, uiContrast));
  root.style.setProperty('--ui-contrast', String(contrastClamped));

  if (pointerCursors) root.classList.add('pointer-cursors');
  else root.classList.remove('pointer-cursors');

  const a = deriveAccent(accent);
  const style = root.style;
  style.setProperty('--accent', a.hex);
  style.setProperty('--accent-hover', a.hover);
  if (resolved === 'light') {
    style.setProperty('--accent-soft', a.soft);
    style.setProperty('--accent-soft-2', a.soft2);
    style.setProperty('--accent-ink', a.ink);
  } else {
    const dark = deriveDarkTints(a.hex);
    style.setProperty('--accent-soft', dark.soft);
    style.setProperty('--accent-soft-2', dark.soft2);
    style.setProperty('--accent-ink', dark.ink);
  }

  if (background === 'default') {
    style.removeProperty('--bg-stop-1');
    style.removeProperty('--bg-stop-2');
    style.removeProperty('--bg-stop-3a');
    style.removeProperty('--bg-stop-3b');
    style.removeProperty('--bg-stop-3c');
    style.removeProperty('--paper');
    style.removeProperty('--paper-2');
    style.removeProperty('--sidebar');
    style.removeProperty('--panel');
  } else {
    const stops = getBackgroundStops(background, resolved, accent);
    style.setProperty('--bg-stop-1', stops.s1);
    style.setProperty('--bg-stop-2', stops.s2);
    style.setProperty('--bg-stop-3a', stops.s3a);
    style.setProperty('--bg-stop-3b', stops.s3b);
    style.setProperty('--bg-stop-3c', stops.s3c);
    // Don't override --panel: page cards keep the theme default (#ffffff /
    // #171a25) in every bg preset, so they read as solid neutral surfaces
    // against the themed body gradient instead of blending into it.
    style.removeProperty('--panel');
    // Body surfaces (--paper, --paper-2) always tint with the bg preset.
    style.setProperty('--paper', stops.paper);
    style.setProperty('--paper-2', stops.paper2);
    // --sidebar only retints with the bg preset when the sidebar is in glass
    // mode — translucent surfaces pick up the bg color naturally. When solid,
    // the sidebar stays at the theme default for a consistent neutral chrome.
    if (translucentSidebar) {
      style.setProperty('--sidebar', stops.sidebar);
    } else {
      style.removeProperty('--sidebar');
    }
  }
  root.setAttribute('data-bg', background);
}

function readStored(): TweaksState {
  if (typeof window === 'undefined') return DEFAULT_TWEAKS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TWEAKS;
    const parsed = JSON.parse(raw) as Partial<TweaksState> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_TWEAKS;
    const validBg: BackgroundKey[] = [
      'default',
      'aurora',
      'mint',
      'peach',
      'slate',
      'dusk',
      'accent',
    ];
    const bg = validBg.includes(parsed.background as BackgroundKey)
      ? (parsed.background as BackgroundKey)
      : DEFAULT_TWEAKS.background;
    const rawSize = Number(parsed.uiFontSize);
    const uiFontSize = Number.isFinite(rawSize)
      ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, rawSize))
      : DEFAULT_TWEAKS.uiFontSize;
    const rawContrast = Number(parsed.uiContrast);
    const uiContrast = Number.isFinite(rawContrast)
      ? Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, rawContrast))
      : DEFAULT_TWEAKS.uiContrast;
    return {
      theme:
        parsed.theme === 'dark' || parsed.theme === 'light' || parsed.theme === 'system'
          ? parsed.theme
          : DEFAULT_TWEAKS.theme,
      accent: typeof parsed.accent === 'string' ? parsed.accent : DEFAULT_TWEAKS.accent,
      background: bg,
      uiFontSize,
      translucentSidebar: parsed.translucentSidebar === true,
      uiContrast,
      pointerCursors: parsed.pointerCursors === true,
    };
  } catch {
    return DEFAULT_TWEAKS;
  }
}

function persist(state: TweaksState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota errors */
  }
}

interface UseDarkModeReturn {
  isDarkMode: boolean;
  theme: ThemeMode;
  accent: string;
  background: BackgroundKey;
  uiFontSize: number;
  translucentSidebar: boolean;
  uiContrast: number;
  pointerCursors: boolean;
  setTheme: (t: ThemeMode) => void;
  setAccent: (hex: string) => void;
  setBackground: (key: BackgroundKey) => void;
  setUiFontSize: (px: number) => void;
  setTranslucentSidebar: (on: boolean) => void;
  setUiContrast: (n: number) => void;
  setPointerCursors: (on: boolean) => void;
}

// Module-level pub/sub so every `useDarkMode` instance shares state.
const listeners = new Set<(s: TweaksState) => void>();

const useDarkMode = (): UseDarkModeReturn => {
  // Initialize to defaults for SSR/hydration consistency, then hydrate from
  // localStorage on mount. `hydrated` gates persist so we don't overwrite the
  // stored value with defaults before the hydration read completes.
  const [tweaks, setTweaksState] = useState<TweaksState>(DEFAULT_TWEAKS);
  const [hydrated, setHydrated] = useState(false);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    setTweaksState(readStored());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    applyTweaks(tweaks);
    persist(tweaks);
  }, [tweaks, hydrated, systemDark]);

  useEffect(() => {
    listeners.add(setTweaksState);
    return () => {
      listeners.delete(setTweaksState);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = readStored();
      listeners.forEach(l => l(next));
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const update = useCallback((updater: (prev: TweaksState) => TweaksState) => {
    setTweaksState(prev => {
      const next = updater(prev);
      if (next === prev) return prev;
      listeners.forEach(l => {
        if (l !== setTweaksState) l(next);
      });
      return next;
    });
  }, []);

  const setTheme = useCallback(
    (t: ThemeMode) => update(prev => (prev.theme === t ? prev : { ...prev, theme: t })),
    [update]
  );
  const setAccent = useCallback(
    (hex: string) => update(prev => (prev.accent === hex ? prev : { ...prev, accent: hex })),
    [update]
  );
  const setBackground = useCallback(
    (key: BackgroundKey) =>
      update(prev => (prev.background === key ? prev : { ...prev, background: key })),
    [update]
  );
  const setUiFontSize = useCallback(
    (px: number) => {
      const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(px)));
      update(prev => (prev.uiFontSize === clamped ? prev : { ...prev, uiFontSize: clamped }));
    },
    [update]
  );
  const setTranslucentSidebar = useCallback(
    (on: boolean) =>
      update(prev => (prev.translucentSidebar === on ? prev : { ...prev, translucentSidebar: on })),
    [update]
  );
  const setUiContrast = useCallback(
    (n: number) => {
      const clamped = Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, Math.round(n)));
      update(prev => (prev.uiContrast === clamped ? prev : { ...prev, uiContrast: clamped }));
    },
    [update]
  );
  const setPointerCursors = useCallback(
    (on: boolean) =>
      update(prev => (prev.pointerCursors === on ? prev : { ...prev, pointerCursors: on })),
    [update]
  );

  const isDarkMode = tweaks.theme === 'system' ? systemDark : tweaks.theme === 'dark';

  return {
    isDarkMode,
    theme: tweaks.theme,
    accent: tweaks.accent,
    background: tweaks.background,
    uiFontSize: tweaks.uiFontSize,
    translucentSidebar: tweaks.translucentSidebar,
    uiContrast: tweaks.uiContrast,
    pointerCursors: tweaks.pointerCursors,
    setTheme,
    setAccent,
    setBackground,
    setUiFontSize,
    setTranslucentSidebar,
    setUiContrast,
    setPointerCursors,
  };
};

export default useDarkMode;
