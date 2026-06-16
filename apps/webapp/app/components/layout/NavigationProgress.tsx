import { useEffect, useRef, useState } from 'react';
import { useNavigation } from 'react-router';

/**
 * A thin top-of-page progress bar that reacts to React Router navigation state.
 * Many route loaders block for 1–3s (e.g. the calendar fetching events), and
 * without feedback the app looks frozen after a click. This bar appears the
 * moment a navigation starts, trickles toward ~90% while the loader runs, then
 * completes and fades out — giving immediate "something is happening" feedback
 * on every route, with no extra dependency.
 */
export function NavigationProgress() {
  const navigation = useNavigation();
  const active = navigation.state !== 'idle';

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const trickleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearTrickle = () => {
      if (trickleRef.current) {
        clearInterval(trickleRef.current);
        trickleRef.current = null;
      }
    };

    if (active) {
      if (hideRef.current) {
        clearTimeout(hideRef.current);
        hideRef.current = null;
      }
      setVisible(true);
      // Jump-start so the bar is immediately visible, then ease toward 90%.
      setProgress(prev => (prev > 0 && prev < 90 ? prev : 12));
      clearTrickle();
      trickleRef.current = setInterval(() => {
        setProgress(prev => (prev < 90 ? prev + (90 - prev) * 0.12 : prev));
      }, 180);
    } else {
      clearTrickle();
      // Finish: snap to 100%, then fade out and reset.
      setProgress(prev => (prev > 0 ? 100 : 0));
      hideRef.current = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 320);
    }

    return clearTrickle;
  }, [active]);

  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-[2000] h-[3px] pointer-events-none"
    >
      <div
        className="h-full rounded-r-full transition-[width,opacity] duration-200 ease-out"
        style={{
          width: `${progress}%`,
          opacity: visible ? 1 : 0,
          backgroundColor: 'var(--accent)',
          boxShadow: '0 0 10px var(--accent), 0 0 4px var(--accent)',
        }}
      />
    </div>
  );
}

export default NavigationProgress;
