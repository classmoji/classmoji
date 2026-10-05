/**
 * Live pointers over a deck's slide: where each person (or agent) has their
 * mouse, in SLIDE coordinates — the deck's logical size, the same for every
 * window size and zoom. Awareness carries it as
 *
 *   pointer: { slide: <data-cm-id>, x, y }   0 ≤ x ≤ width, 0 ≤ y ≤ height
 *
 * and drops the field (null) when the pointer leaves the slide.
 *
 * Pure: no DOM, no Yjs. The server, the slides editor and MCP import it.
 */

/** A pointer on one slide, in the deck's logical coordinates. */
export interface SlidePointer {
  slide: string;
  x: number;
  y: number;
}

export interface SlideSize {
  width: number;
  height: number;
}

/** Reveal's default slide size, which every deck uses (the editor sets none). */
export const DECK_SLIDE_SIZE: SlideSize = { width: 960, height: 700 };

/** At most this many other pointers show at once (the most recently moved). */
export const SLIDE_POINTERS_MAX = 10;

const MAX_SLIDE_ID = 200;

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/**
 * A well-formed pointer from untrusted input, its coordinates clamped onto
 * the slide; null for anything else (no slide id, non-finite numbers).
 */
export function normalizeSlidePointer(
  value: unknown,
  size: SlideSize = DECK_SLIDE_SIZE
): SlidePointer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { slide?: unknown; x?: unknown; y?: unknown };
  if (typeof raw.slide !== 'string' || !raw.slide || raw.slide.length > MAX_SLIDE_ID) return null;
  if (typeof raw.x !== 'number' || !Number.isFinite(raw.x)) return null;
  if (typeof raw.y !== 'number' || !Number.isFinite(raw.y)) return null;
  return { slide: raw.slide, x: clamp(raw.x, size.width), y: clamp(raw.y, size.height) };
}

/** Where an agent's pointer rests on a slide when it names no spot: the centre. */
export function agentRestPoint(size: SlideSize = DECK_SLIDE_SIZE): { x: number; y: number } {
  return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
}

/** Another person's or agent's pointer, as the editor draws it. */
export interface PeerPointer {
  clientId: number;
  /** The awareness name (an agent's includes its tag: `Ada (agent)`). */
  name: string;
  color: string;
  agent: boolean;
  x: number;
  y: number;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FALLBACK_COLOR = '#6b7280';

export interface PointerFilter {
  localClientId: number;
  /** The local user: their other tabs are "you" too. */
  localUserId: string;
  /** The slide the viewer is on; pointers elsewhere do not show. */
  slideId: string | null;
  size?: SlideSize;
  /** Most recent move per client (larger = newer), to keep the newest `max`. */
  movedAt?: ReadonlyMap<number, number>;
  max?: number;
}

/**
 * The pointers to draw over the viewer's slide: other clients only (never
 * this one or another tab of the same user), named, on that slide, with
 * finite coordinates (clamped onto it); the `max` most recently moved,
 * ordered by client id so the list is stable.
 */
export function pointersFromStates(
  states: Iterable<[number, unknown]>,
  filter: PointerFilter
): PeerPointer[] {
  const { localClientId, localUserId, slideId } = filter;
  if (!slideId) return [];
  const size = filter.size ?? DECK_SLIDE_SIZE;
  const out: PeerPointer[] = [];
  for (const [clientId, raw] of states) {
    if (clientId === localClientId || !raw || typeof raw !== 'object') continue;
    const state = raw as { user?: unknown; pointer?: unknown };
    const user = state.user as
      | { id?: unknown; name?: unknown; color?: unknown; agent?: unknown }
      | undefined;
    if (!user || typeof user.name !== 'string' || !user.name) continue;
    if (typeof user.id === 'string' && user.id === localUserId) continue;
    const pointer = normalizeSlidePointer(state.pointer, size);
    if (!pointer || pointer.slide !== slideId) continue;
    out.push({
      clientId,
      name: user.name.slice(0, 200),
      color:
        typeof user.color === 'string' && HEX_COLOR.test(user.color) ? user.color : FALLBACK_COLOR,
      agent: user.agent === true,
      x: pointer.x,
      y: pointer.y,
    });
  }
  const max = filter.max ?? SLIDE_POINTERS_MAX;
  let kept = out;
  if (out.length > max) {
    const moved = filter.movedAt;
    kept = [...out]
      .sort((a, b) => (moved?.get(b.clientId) ?? 0) - (moved?.get(a.clientId) ?? 0))
      .slice(0, max);
  }
  return kept.sort((a, b) => a.clientId - b.clientId);
}
