import type { DemoBase, Step } from '../types/demo';

/** Fixed design size of every demo stage; it is scaled to fit its card. */
export const STAGE = { width: 840, height: 540 } as const;

export const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

export function moveTo<S extends DemoBase>(target: string | null) {
  return (s: S): S => ({ ...s, cursor: target });
}

export function clickAnd<S extends DemoBase>(update?: (s: S) => S) {
  return (s: S): S => {
    const next = { ...s, click: s.click + 1 };
    return update ? update(next) : next;
  };
}

export function typeSteps<S>(
  start: number,
  text: string,
  every: number,
  apply: (s: S, typed: string) => S,
  by: 'char' | 'word' = 'char'
): Step<S>[] {
  if (by === 'word') {
    const words = text.split(' ');
    return words.map((_, i) => ({
      at: start + i * every,
      action: (s: S) => apply(s, words.slice(0, i + 1).join(' ')),
    }));
  }
  return Array.from({ length: text.length }, (_, i) => ({
    at: start + i * every,
    action: (s: S) => apply(s, text.slice(0, i + 1)),
  }));
}

export function offset<S>(steps: Step<S>[], by: number): Step<S>[] {
  return steps.map(st => ({ at: st.at + by, action: st.action }));
}
