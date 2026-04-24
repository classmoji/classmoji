import { type CSSProperties } from 'react';
import { IconSun, IconMoon, IconCheck } from '@tabler/icons-react';

import { useDarkMode } from '~/hooks';
import { BACKGROUNDS, type BackgroundKey } from '~/hooks/useDarkMode';
import { SettingSection } from '~/components';

// Inline personal "Tweaks" for accent color, light/dark appearance, and
// background preset. Renders in the classroom settings page next to the
// classroom Theme section. Replaces the floating Tweaks FAB.

interface AccentPreset {
  name: string;
  hex: string;
}

const ACCENTS: AccentPreset[] = [
  { name: 'Violet', hex: '#6d5efc' },
  { name: 'Indigo', hex: '#4f46e5' },
  { name: 'Sky', hex: '#0ea5e9' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Fuchsia', hex: '#d946ef' },
  { name: 'Slate', hex: '#475569' },
  { name: 'Crimson', hex: '#dc2626' },
  { name: 'Lime', hex: '#84cc16' },
];

const TweaksSection = () => {
  const { theme, accent, background, setTheme, setAccent, setBackground } = useDarkMode();

  const isCustom = !ACCENTS.some(a => a.hex.toLowerCase() === accent.toLowerCase());

  const segBtn = (active: boolean) =>
    `flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      active
        ? 'bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 shadow-sm'
        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
    }`;

  return (
    <SettingSection
      title="Appearance"
      description="Personal tweaks for accent color, light/dark mode, and background. Saved to this browser."
    >
      <div className="space-y-6">
        {/* Appearance mode */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            Mode
          </div>
          <div
            role="radiogroup"
            aria-label="Appearance"
            className="inline-flex w-full max-w-xs p-1 rounded-xl bg-stone-100 dark:bg-neutral-800 gap-1"
          >
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'light'}
              className={segBtn(theme === 'light')}
              onClick={() => setTheme('light')}
            >
              <IconSun size={16} /> Light
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'dark'}
              className={segBtn(theme === 'dark')}
              onClick={() => setTheme('dark')}
            >
              <IconMoon size={16} /> Dark
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

          {/* Custom color */}
          <div className="mt-3 flex items-center gap-3 p-2.5 pr-3 border border-dashed border-stone-300 dark:border-neutral-700 rounded-lg max-w-xs">
            <input
              type="color"
              value={accent}
              onChange={e => setAccent(e.target.value)}
              aria-label="Custom accent color"
              className="h-7 w-7 rounded cursor-pointer border-0 p-0 bg-transparent"
            />
            <div className="text-sm text-gray-600 dark:text-gray-300 flex-1">Custom</div>
            <div className="font-mono text-xs uppercase text-gray-700 dark:text-gray-200">
              {accent.toUpperCase()}
            </div>
          </div>
        </div>

        {/* Background presets */}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            Background
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                  : theme === 'dark'
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

        <p className="text-xs text-gray-500 dark:text-gray-400">Saved automatically to this browser.</p>
      </div>
    </SettingSection>
  );
};

export default TweaksSection;
