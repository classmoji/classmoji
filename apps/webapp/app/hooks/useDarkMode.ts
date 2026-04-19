import { useEffect, useState, useCallback } from 'react';

// Tweaks-aware dark mode + accent color hook.
// Reads/writes `cm-tweaks` from localStorage and applies the chosen theme +
// accent color (and derived tints) to the document root. Used by the Tweaks
// FAB (`TweaksPanel`) and by `root.tsx` to flip AntD's dark algorithm.

export type ThemeMode = 'light' | 'dark';

export interface TweaksState {
  theme: ThemeMode;
  accent: string;
}

const STORAGE_KEY = 'cm-tweaks';
const DEFAULT_TWEAKS: TweaksState = { theme: 'light', accent: '#6d5efc' };

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
  const expanded = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
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

export function applyTweaks({ theme, accent }: TweaksState): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');

  const a = deriveAccent(accent);
  const style = root.style;
  style.setProperty('--accent', a.hex);
  style.setProperty('--accent-hover', a.hover);
  if (theme === 'light') {
    style.setProperty('--accent-soft', a.soft);
    style.setProperty('--accent-soft-2', a.soft2);
    style.setProperty('--accent-ink', a.ink);
  } else {
    // Dark mode: let CSS theme tokens (html.dark) handle these tints
    style.removeProperty('--accent-soft');
    style.removeProperty('--accent-soft-2');
    style.removeProperty('--accent-ink');
  }
}

function readStored(): TweaksState {
  if (typeof window === 'undefined') return DEFAULT_TWEAKS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TWEAKS;
    const parsed = JSON.parse(raw) as Partial<TweaksState> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_TWEAKS;
    return {
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
      accent: typeof parsed.accent === 'string' ? parsed.accent : DEFAULT_TWEAKS.accent,
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
  setTheme: (t: ThemeMode) => void;
  setAccent: (hex: string) => void;
}

const useDarkMode = (): UseDarkModeReturn => {
  // Initialize from localStorage so SSR -> hydration matches the boot script.
  const [tweaks, setTweaks] = useState<TweaksState>(() => readStored());

  // Apply tweaks on mount and whenever they change.
  useEffect(() => {
    applyTweaks(tweaks);
    persist(tweaks);
  }, [tweaks]);

  // Sync across tabs.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setTweaks(readStored());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const setTheme = useCallback((t: ThemeMode) => {
    setTweaks(prev => (prev.theme === t ? prev : { ...prev, theme: t }));
  }, []);
  const setAccent = useCallback((hex: string) => {
    setTweaks(prev => (prev.accent === hex ? prev : { ...prev, accent: hex }));
  }, []);

  return {
    isDarkMode: tweaks.theme === 'dark',
    theme: tweaks.theme,
    accent: tweaks.accent,
    setTheme,
    setAccent,
  };
};

export default useDarkMode;
