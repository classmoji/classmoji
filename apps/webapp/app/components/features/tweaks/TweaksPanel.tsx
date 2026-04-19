import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useDarkMode } from '~/hooks';
import { BACKGROUNDS, type BackgroundKey } from '~/hooks/useDarkMode';

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
  const { theme, accent, background, setTheme, setAccent, setBackground } = useDarkMode();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);

  // Click-outside + Escape close the panel.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (fabRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isCustom = !ACCENTS.some(a => a.hex.toLowerCase() === accent.toLowerCase());

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className="tweaks-fab"
        onClick={() => setOpen(v => !v)}
        aria-label={open ? 'Close Tweaks' : 'Open Tweaks'}
        aria-expanded={open}
        title="Tweaks"
      >
        <SparklesIcon />
      </button>
      {open && (
    <div ref={panelRef} className="tweaks-panel" role="dialog" aria-label="Tweaks">
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
          <div className="tw-segment" role="radiogroup" aria-label="Appearance">
            <button
              type="button"
              className={`tw-seg-btn ${theme === 'light' ? 'active' : ''}`}
              onClick={() => setTheme('light')}
              role="radio"
              aria-checked={theme === 'light'}
            >
              <SunIcon /> Light
            </button>
            <button
              type="button"
              className={`tw-seg-btn ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => setTheme('dark')}
              role="radio"
              aria-checked={theme === 'dark'}
            >
              <MoonIcon /> Dark
            </button>
          </div>
        </div>

        {/* Accent swatches */}
        <div className="tw-row">
          <div className="tw-label">Accent</div>
          <div className="tw-swatches">
            {ACCENTS.map(a => {
              const isActive = !isCustom && accent.toLowerCase() === a.hex.toLowerCase();
              return (
                <button
                  type="button"
                  key={a.hex}
                  className={`tw-swatch ${isActive ? 'active' : ''}`}
                  style={{ ['--sw' as string]: a.hex } as CSSProperties}
                  title={a.name}
                  onClick={() => setAccent(a.hex)}
                  aria-label={`Accent ${a.name}`}
                  aria-pressed={isActive}
                />
              );
            })}
          </div>
        </div>

        {/* Background presets */}
        <div className="tw-row">
          <div className="tw-label">Background</div>
          <div className="tw-bgs">
            {BACKGROUNDS.map(bg => {
              const stops = bg.key === 'accent'
                ? {
                    s1: accent,
                    s2: accent,
                    s3a: accent,
                    s3b: accent,
                    s3c: accent,
                  }
                : theme === 'dark' ? bg.dark : bg.light;
              const preview = bg.key === 'accent'
                ? `radial-gradient(60% 80% at 80% 10%, ${accent}40 0%, transparent 65%), radial-gradient(60% 80% at 10% 100%, ${accent}26 0%, transparent 60%), linear-gradient(160deg, ${accent}18 0%, ${accent}0a 100%)`
                : `radial-gradient(60% 80% at 80% 10%, ${stops.s1} 0%, transparent 65%), radial-gradient(60% 80% at 10% 100%, ${stops.s2} 0%, transparent 60%), linear-gradient(160deg, ${stops.s3a} 0%, ${stops.s3b} 55%, ${stops.s3c} 100%)`;
              const isActive = background === bg.key;
              return (
                <button
                  type="button"
                  key={bg.key}
                  className={`tw-bg ${isActive ? 'active' : ''}`}
                  style={{ ['--bg-preview' as string]: preview } as CSSProperties}
                  title={bg.name}
                  onClick={() => setBackground(bg.key as BackgroundKey)}
                  aria-label={`Background ${bg.name}`}
                  aria-pressed={isActive}
                >
                  <span className="tw-bg-name">{bg.name}</span>
                </button>
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
      )}
    </>
  );
};

export default TweaksPanel;
