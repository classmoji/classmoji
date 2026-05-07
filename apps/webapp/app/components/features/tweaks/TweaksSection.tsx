import { type CSSProperties, useEffect, useState } from 'react';
import { IconSun, IconMoon, IconDeviceLaptop, IconCheck } from '@tabler/icons-react';

import { useDarkMode } from '~/hooks';
import {
  BACKGROUNDS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  CONTRAST_MIN,
  CONTRAST_MAX,
  type BackgroundKey,
} from '~/hooks/useDarkMode';
import { SettingSection } from '~/components';

// Inline personal "Tweaks" for accent color, light/dark appearance, and
// background preset. Renders in the classroom settings page next to the
// classroom Theme section. Replaces the floating Tweaks FAB.

interface AccentPreset {
  name: string;
  hex: string;
}

const ACCENTS: AccentPreset[] = [
  { name: 'Sky', hex: '#0ea5e9' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Fuchsia', hex: '#d946ef' },
  { name: 'Slate', hex: '#475569' },
  { name: 'Crimson', hex: '#dc2626' },
  { name: 'Lime', hex: '#84cc16' },
];

const TweaksSection = () => {
  const {
    isDarkMode,
    theme,
    accent,
    background,
    uiFontSize,
    translucentSidebar,
    uiContrast,
    pointerCursors,
    setTheme,
    setAccent,
    setBackground,
    setUiFontSize,
    setTranslucentSidebar,
    setUiContrast,
    setPointerCursors,
  } = useDarkMode();
  const [fontDraft, setFontDraft] = useState<string>(String(uiFontSize));

  useEffect(() => {
    setFontDraft(String(uiFontSize));
  }, [uiFontSize]);

  const commitFontSize = () => {
    const parsed = parseInt(fontDraft, 10);
    if (Number.isFinite(parsed)) setUiFontSize(parsed);
    else setFontDraft(String(uiFontSize));
  };

  const isCustom = !ACCENTS.some(a => a.hex.toLowerCase() === accent.toLowerCase());

  const segBtn = (active: boolean) =>
    `inline-flex min-w-0 items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-sm font-medium transition-colors @[280px]:gap-2 @[280px]:px-3 ${
      active
        ? 'bg-panel text-gray-900 dark:text-gray-100 shadow-sm'
        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
    }`;

  return (
    <SettingSection
      title="Appearance"
      description="Personalize your theme, accent color, and background."
    >
      <div className="space-y-6">
        {/* Theme */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            Theme
          </div>
          <div
            role="radiogroup"
            aria-label="Theme"
            className="@container grid grid-cols-3 w-full max-w-sm p-1 rounded-xl bg-stone-100 dark:bg-neutral-800 gap-1"
          >
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'light'}
              aria-label="Light"
              className={segBtn(theme === 'light')}
              onClick={() => setTheme('light')}
            >
              <IconSun className="size-5 shrink-0" />
              <span className="hidden @[280px]:inline">Light</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'dark'}
              aria-label="Dark"
              className={segBtn(theme === 'dark')}
              onClick={() => setTheme('dark')}
            >
              <IconMoon className="size-5 shrink-0" />
              <span className="hidden @[280px]:inline">Dark</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'system'}
              aria-label="System"
              className={segBtn(theme === 'system')}
              onClick={() => setTheme('system')}
            >
              <IconDeviceLaptop className="size-5 shrink-0" />
              <span className="hidden @[280px]:inline">System</span>
            </button>
          </div>
        </div>

        {/* Accent swatches */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            Accent
          </div>
          <div className="flex flex-wrap gap-3">
            {ACCENTS.map(a => {
              const isActive = !isCustom && accent.toLowerCase() === a.hex.toLowerCase();
              return (
                <button
                  type="button"
                  key={a.hex}
                  onClick={() => setAccent(a.hex)}
                  title={a.name}
                  aria-label={`Accent ${a.name}`}
                  aria-pressed={isActive}
                  className={`group relative h-10 w-10 rounded-full transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-900 dark:focus:ring-gray-100 focus:ring-offset-white dark:focus:ring-offset-neutral-900 ${
                    isActive
                      ? 'ring-2 ring-offset-2 ring-gray-900 dark:ring-gray-100 ring-offset-white dark:ring-offset-neutral-900'
                      : ''
                  }`}
                  style={{ backgroundColor: a.hex }}
                >
                  {isActive && (
                    <IconCheck
                      size={18}
                      className="absolute inset-0 m-auto text-white drop-shadow"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Background presets */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            Background
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2">
            {BACKGROUNDS.map(bg => {
              const stops =
                bg.key === 'accent'
                  ? {
                      s1: accent,
                      s2: accent,
                      s3a: accent,
                      s3b: accent,
                      s3c: accent,
                    }
                  : isDarkMode
                    ? bg.dark
                    : bg.light;
              const preview =
                bg.key === 'accent'
                  ? `radial-gradient(60% 80% at 80% 10%, ${accent}40 0%, transparent 65%), radial-gradient(60% 80% at 10% 100%, ${accent}26 0%, transparent 60%), linear-gradient(160deg, ${accent}18 0%, ${accent}0a 100%)`
                  : `radial-gradient(60% 80% at 80% 10%, ${stops.s1} 0%, transparent 65%), radial-gradient(60% 80% at 10% 100%, ${stops.s2} 0%, transparent 60%), linear-gradient(160deg, ${stops.s3a} 0%, ${stops.s3b} 55%, ${stops.s3c} 100%)`;
              const isActive = background === bg.key;
              return (
                <button
                  type="button"
                  key={bg.key}
                  onClick={() => setBackground(bg.key as BackgroundKey)}
                  aria-label={`Background ${bg.name}`}
                  aria-pressed={isActive}
                  className={`relative overflow-hidden rounded-lg border-2 transition-all hover:-translate-y-0.5 focus:outline-none ${
                    isActive
                      ? 'border-gray-900 dark:border-gray-100 shadow-sm'
                      : 'border-stone-200 dark:border-neutral-700 hover:border-stone-400 dark:hover:border-neutral-500'
                  }`}
                  style={{ aspectRatio: '1.35', background: preview } as CSSProperties}
                >
                  <span className="absolute inset-x-0 bottom-0 px-2 py-1 text-[11px] font-medium text-center text-gray-800 dark:text-gray-100 bg-white/70 dark:bg-black/40 backdrop-blur-sm">
                    {bg.name}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* UI font size */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            UI font size
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Adjust the base size used for the UI.
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                value={fontDraft}
                onChange={e => setFontDraft(e.target.value)}
                onBlur={commitFontSize}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="UI font size in pixels"
                className="w-16 text-center rounded-lg border border-stone-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100 px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]"
              />
              <span className="text-sm text-gray-500 dark:text-gray-400">px</span>
            </div>
          </div>
        </div>

        {/* Translucent sidebar toggle */}
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-gray-700 dark:text-gray-200">Translucent sidebar</div>
          <button
            type="button"
            role="switch"
            aria-checked={translucentSidebar}
            onClick={() => setTranslucentSidebar(!translucentSidebar)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--accent)] focus:ring-offset-white dark:focus:ring-offset-neutral-900 ${
              translucentSidebar ? 'bg-[var(--accent)]' : 'bg-stone-300 dark:bg-neutral-700'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                translucentSidebar ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Pointer cursors toggle */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-gray-700 dark:text-gray-200">Use pointer cursors</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Use a pointer cursor on hover for clickable elements.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={pointerCursors}
            onClick={() => setPointerCursors(!pointerCursors)}
            className={`mt-0.5 relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--accent)] focus:ring-offset-white dark:focus:ring-offset-neutral-900 ${
              pointerCursors ? 'bg-[var(--accent)]' : 'bg-stone-300 dark:bg-neutral-700'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                pointerCursors ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Contrast slider */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            Contrast
          </div>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={CONTRAST_MIN}
              max={CONTRAST_MAX}
              step={1}
              value={uiContrast}
              onChange={e => setUiContrast(Number(e.target.value))}
              aria-label="UI contrast"
              className="flex-1 accent-[var(--accent)]"
            />
            <span className="w-8 text-right tabular-nums text-sm text-gray-600 dark:text-gray-300">
              {uiContrast}
            </span>
          </div>
        </div>
      </div>
    </SettingSection>
  );
};

export default TweaksSection;
