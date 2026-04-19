import { useState, type CSSProperties } from 'react';
import { useDarkMode } from '~/hooks';

// Pastel-redesign Tweaks FAB: lets the signed-in user flip between light/dark
// theme and pick from 12 accent presets (or a custom hex). Persists choice via
// the `useDarkMode` hook (localStorage key `cm-tweaks`). Floats bottom-right.

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

const SunIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

const SparklesIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" />
    <path d="M19 14l0.9 2.1L22 17l-2.1 0.9L19 20l-0.9-2.1L16 17l2.1-0.9L19 14z" />
  </svg>
);

const CloseIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const TweaksPanel = () => {
  const { theme, accent, setTheme, setAccent } = useDarkMode();
  const [open, setOpen] = useState(false);

  const isCustom = !ACCENTS.some(a => a.hex.toLowerCase() === accent.toLowerCase());

  if (!open) {
    return (
      <button
        type="button"
        className="tweaks-fab"
        onClick={() => setOpen(true)}
        aria-label="Open Tweaks"
        title="Tweaks"
      >
        <SparklesIcon />
      </button>
    );
  }

  return (
    <div className="tweaks-panel" role="dialog" aria-label="Tweaks">
      <div className="tweaks-head">
        <div className="t-title">Tweaks</div>
        <button
          type="button"
          className="t-close"
          onClick={() => setOpen(false)}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="tweaks-body">
        {/* Theme mode */}
        <div className="tw-row">
          <div className="tw-label">Appearance</div>
          <div className="tw-segment">
            <div
              className={`tw-seg-btn ${theme === 'light' ? 'active' : ''}`}
              onClick={() => setTheme('light')}
              role="button"
              tabIndex={0}
              onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setTheme('light')}
            >
              <SunIcon /> Light
            </div>
            <div
              className={`tw-seg-btn ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => setTheme('dark')}
              role="button"
              tabIndex={0}
              onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setTheme('dark')}
            >
              <MoonIcon /> Dark
            </div>
          </div>
        </div>

        {/* Accent swatches */}
        <div className="tw-row">
          <div className="tw-label">Accent</div>
          <div className="tw-swatches">
            {ACCENTS.map(a => {
              const isActive = !isCustom && accent.toLowerCase() === a.hex.toLowerCase();
              return (
                <div
                  key={a.hex}
                  className={`tw-swatch ${isActive ? 'active' : ''}`}
                  style={{ ['--sw' as string]: a.hex } as CSSProperties}
                  title={a.name}
                  onClick={() => setAccent(a.hex)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Accent ${a.name}`}
                  onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setAccent(a.hex)}
                />
              );
            })}
          </div>
        </div>

        {/* Custom color */}
        <div className="tw-custom">
          <input
            type="color"
            value={accent}
            onChange={e => setAccent(e.target.value)}
            aria-label="Custom accent color"
          />
          <div className="tw-custom-label">Custom</div>
          <div className="tw-hex">{accent.toUpperCase()}</div>
        </div>
      </div>
      <div className="tw-foot">Saved automatically.</div>
    </div>
  );
};

export default TweaksPanel;
