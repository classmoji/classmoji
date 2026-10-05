/**
 * Live pointers, the editor's half: screen ↔ slide coordinates and the
 * throttle that sends the local pointer into awareness.
 *
 * Slide coordinates are the deck's logical size (DECK_SLIDE_SIZE, Reveal's
 * 960×700): the same spot on a slide has the same coordinates in every
 * window, whatever Reveal's scale. The frame is where the scaled slide box
 * (`.reveal .slides`, transform-scaled by Reveal) sits on screen.
 *
 * Pure: no DOM (the component measures the frame), no Yjs.
 */
import { DECK_SLIDE_SIZE, type SlideSize } from '@classmoji/collab';

/** The slide box on screen: where it starts and how big it is drawn. */
export interface SlideFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A screen point in slide coordinates, or null when it is outside the slide
 * (or the frame has no size yet). Rounded to whole slide pixels.
 */
export function screenToSlide(
  point: { x: number; y: number },
  frame: SlideFrame,
  size: SlideSize = DECK_SLIDE_SIZE
): { x: number; y: number } | null {
  if (!(frame.width > 0) || !(frame.height > 0)) return null;
  const fx = (point.x - frame.left) / frame.width;
  const fy = (point.y - frame.top) / frame.height;
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return null;
  return { x: Math.round(fx * size.width), y: Math.round(fy * size.height) };
}

/** A slide point where it is drawn now (screen, or any space the frame is in). */
export function slideToScreen(
  point: { x: number; y: number },
  frame: SlideFrame,
  size: SlideSize = DECK_SLIDE_SIZE
): { x: number; y: number } {
  return {
    x: frame.left + (point.x / size.width) * frame.width,
    y: frame.top + (point.y / size.height) * frame.height,
  };
}

/** The frame in another box's coordinates (the overlay draws relative to its own box). */
export function frameWithin(
  frame: SlideFrame,
  container: { left: number; top: number }
): SlideFrame {
  return {
    left: frame.left - container.left,
    top: frame.top - container.top,
    width: frame.width,
    height: frame.height,
  };
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/** At most one pointer update per this many ms (20 a second). */
export const POINTER_SEND_INTERVAL_MS = 50;

export interface SentPointer {
  slide: string;
  x: number;
  y: number;
}

export interface PointerSenderDeps {
  send(pointer: SentPointer | null): void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  intervalMs?: number;
}

const samePointer = (a: SentPointer | null, b: SentPointer | null) =>
  a === b || (!!a && !!b && a.slide === b.slide && a.x === b.x && a.y === b.y);

/**
 * Sends the local pointer at most every `intervalMs`, on an animation frame:
 * moves in between collapse into the latest one, an unchanged pointer is not
 * sent again, and `clear()` sends "no pointer" at once (dropping any move
 * still waiting).
 */
export class PointerSender {
  private readonly deps: Required<PointerSenderDeps>;
  private last: SentPointer | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;
  private pending: SentPointer | null = null;
  private frame: number | null = null;
  private timer: unknown = null;
  private stopped = false;

  constructor(deps: PointerSenderDeps) {
    this.deps = {
      now: () => performance.now(),
      requestFrame: callback => requestAnimationFrame(callback),
      cancelFrame: handle => cancelAnimationFrame(handle),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      intervalMs: POINTER_SEND_INTERVAL_MS,
      ...deps,
    };
  }

  /** The pointer moved (slide coordinates are rounded before comparing). */
  move(pointer: SentPointer): void {
    if (this.stopped) return;
    const next = { slide: pointer.slide, x: Math.round(pointer.x), y: Math.round(pointer.y) };
    this.pending = next;
    if (this.frame !== null || this.timer !== null) return;
    if (samePointer(next, this.last)) {
      this.pending = null;
      return;
    }
    const wait = this.lastAt + this.deps.intervalMs - this.deps.now();
    if (wait > 0) {
      this.timer = this.deps.setTimer(() => {
        this.timer = null;
        this.schedule();
      }, wait);
    } else {
      this.schedule();
    }
  }

  /** The pointer left the slide (or the window): no pointer, now. */
  clear(): void {
    this.cancel();
    this.pending = null;
    if (this.last !== null) {
      this.last = null;
      this.lastAt = this.deps.now();
      this.deps.send(null);
    }
  }

  /** Clear, then ignore everything after (unmount). */
  stop(): void {
    this.clear();
    this.stopped = true;
  }

  private schedule() {
    if (this.frame !== null) return;
    this.frame = this.deps.requestFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private flush() {
    const next = this.pending;
    this.pending = null;
    if (!next || this.stopped || samePointer(next, this.last)) return;
    this.last = next;
    this.lastAt = this.deps.now();
    this.deps.send(next);
  }

  private cancel() {
    if (this.frame !== null) this.deps.cancelFrame(this.frame);
    this.frame = null;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}

// ─── Resting ─────────────────────────────────────────────────────────────────

/** A person's arrow rests (dims, its name hides) after this long without moving. */
export const POINTER_REST_MS = 4_000;

/**
 * When each remote pointer last moved, by this editor's own clock: a renewal
 * of the same position is not a move. Agents never rest.
 */
export class PointerMotion {
  private readonly seen = new Map<number, { key: string; at: number }>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Record the pointers now shown; forget clients that no longer have one. */
  update(pointers: Iterable<{ clientId: number; x: number; y: number; slide?: string }>): void {
    const at = this.now();
    const live = new Set<number>();
    for (const p of pointers) {
      live.add(p.clientId);
      const key = `${p.slide ?? ''}:${p.x}:${p.y}`;
      const prev = this.seen.get(p.clientId);
      if (!prev || prev.key !== key) this.seen.set(p.clientId, { key, at });
    }
    for (const id of [...this.seen.keys()]) if (!live.has(id)) this.seen.delete(id);
  }

  /** Last move per client (for keeping the most recently moved). */
  movedAt(): Map<number, number> {
    return new Map([...this.seen].map(([id, v]) => [id, v.at]));
  }

  resting(clientId: number, agent: boolean): boolean {
    if (agent) return false;
    const seen = this.seen.get(clientId);
    return !!seen && this.now() - seen.at >= POINTER_REST_MS;
  }

  /** Ms until the next shown pointer comes to rest, or null when none will. */
  nextRestIn(agents: ReadonlySet<number> = new Set()): number | null {
    let next: number | null = null;
    const now = this.now();
    for (const [id, { at }] of this.seen) {
      if (agents.has(id)) continue;
      const left = at + POINTER_REST_MS - now;
      if (left > 0 && (next === null || left < next)) next = left;
    }
    return next;
  }
}
