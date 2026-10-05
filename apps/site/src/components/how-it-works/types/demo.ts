export type DemoBase = {
  /** data-cursor id of the element the fake cursor points at; null = resting position */
  cursor: string | null;
  /** increments on every fake click, drives the ripple */
  click: number;
};

export type Step<S> = {
  at: number;
  action: (s: S) => S;
};

export type DemoMode = 'idle' | 'playing' | 'static';
