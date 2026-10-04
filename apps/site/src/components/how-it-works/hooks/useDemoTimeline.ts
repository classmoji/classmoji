import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useReducedMotion } from 'framer-motion';
import type { DemoBase, DemoMode, Step } from '../types/demo';

/** A slightly slower pace gives each cursor action and UI response time to register. */
const PLAYBACK_RATE = 0.85;

type Options<S> = {
  initial: S;
  steps: Step<S>[];
  /** when the story ends, in ms */
  duration: number;
  /** how long the final state is held before looping */
  hold?: number;
};

export type DemoController<S> = {
  state: S;
  mode: DemoMode;
  containerRef: RefObject<HTMLElement>;
  /** apply an update immediately */
  act: (fn: (s: S) => S) => void;
  /** schedule a mini-timeline from now */
  sequence: (steps: Step<S>[]) => void;
};

export function useDemoTimeline<S extends DemoBase>({
  initial,
  steps,
  duration,
  hold = 2000,
}: Options<S>): DemoController<S> {
  const reduced = useReducedMotion() ?? false;
  const sorted = useMemo(() => [...steps].sort((a, b) => a.at - b.at), [steps]);
  const finalState = useMemo<S>(
    () => ({ ...sorted.reduce((s, st) => st.action(s), initial), cursor: null }),
    [sorted, initial],
  );

  const [state, setState] = useState<S>(initial);
  const [inView, setInView] = useState(false);

  const containerRef = useRef<HTMLElement>(null);
  const elapsed = useRef(0);
  const index = useRef(0);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  useEffect(() => clearTimers, []);

  // Reduced motion: show only the final state.
  useEffect(() => {
    if (reduced) setState(finalState);
  }, [reduced, finalState]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.35,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = !reduced && inView;

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsed.current += Math.min(now - last, 100) * PLAYBACK_RATE;
      last = now;
      if (elapsed.current >= duration + hold) {
        elapsed.current = 0;
        index.current = 0;
        setState(initial);
      } else {
        const due: Step<S>[] = [];
        while (index.current < sorted.length && sorted[index.current].at <= elapsed.current) {
          due.push(sorted[index.current]);
          index.current += 1;
        }
        if (due.length) setState((s) => due.reduce((acc, st) => st.action(acc), s));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, duration, hold, sorted, initial]);

  const act = useCallback((fn: (s: S) => S) => setState(fn), []);

  const sequence = useCallback((seq: Step<S>[]) => {
    seq.forEach((st) => {
      timers.current.push(window.setTimeout(() => setState(st.action), st.at));
    });
  }, []);

  const mode: DemoMode = reduced ? 'static' : inView ? 'playing' : 'idle';

  return { state, mode, containerRef, act, sequence };
}
