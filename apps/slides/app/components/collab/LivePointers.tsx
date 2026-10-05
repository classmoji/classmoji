import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { IconSparkles } from '@tabler/icons-react';
import { pointersFromStates, textOnColor, type PeerPointer } from '@classmoji/collab';

import type { DeckCollabSession } from '~/utils/collab/session';
import {
  PointerMotion,
  PointerSender,
  frameWithin,
  screenToSlide,
  slideToScreen,
  type SlideFrame,
} from '~/utils/collab/pointer';

/** How an arrow glides to its next spot (pointers arrive up to 20 times a second). */
const GLIDE = 'transform 140ms ease-out, opacity 300ms ease-out';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia?.(REDUCED_MOTION);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia?.(REDUCED_MOTION).matches ?? false,
    () => false
  );
}

interface ShownPointer extends PeerPointer {
  resting: boolean;
}

/**
 * Live pointers over the slide in the live editor: this person's mouse goes
 * into awareness (slide coordinates, at most 20 times a second, none when it
 * is off the slide, the window is in the background, or the slide changes);
 * everyone else's on the same slide is drawn as an arrow in their colour with
 * their name, gliding between positions. A person's arrow dims and its name
 * hides after a few seconds without moving; an agent's stays while the agent
 * is present.
 *
 * Drawn in a layer above the slide, never inside it: no pointer events, not
 * part of the deck. Mounted inside the slide area, whose box it covers.
 */
export default function LivePointers({
  session,
  reveal,
  slideId,
  hidden = false,
}: {
  session: DeckCollabSession | null;
  reveal: RevealApi | null;
  /** The slide the viewer is on (data-cm-id). */
  slideId: string | null;
  /** Something covers the slide (the overview): neither send nor show. */
  hidden?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<SlideFrame | null>(null);
  const [pointers, setPointers] = useState<ShownPointer[]>([]);
  const reducedMotion = usePrefersReducedMotion();

  const slidesElement = useCallback((): HTMLElement | null => {
    const fromReveal = reveal?.getSlidesElement?.() ?? null;
    if (fromReveal?.isConnected) return fromReveal;
    return rootRef.current?.parentElement?.querySelector<HTMLElement>('.reveal .slides') ?? null;
  }, [reveal]);

  // ── Where the slide is drawn (follows resizes and Reveal's scale) ─────────
  useEffect(() => {
    const root = rootRef.current;
    const area = root?.parentElement;
    if (!root || !area) return;
    let frameHandle = 0;
    const measure = () => {
      const slides = slidesElement();
      if (!slides) return setFrame(null);
      const next = frameWithin(slides.getBoundingClientRect(), root.getBoundingClientRect());
      setFrame(current =>
        current &&
        Math.abs(current.left - next.left) < 0.5 &&
        Math.abs(current.top - next.top) < 0.5 &&
        Math.abs(current.width - next.width) < 0.5 &&
        Math.abs(current.height - next.height) < 0.5
          ? current
          : next
      );
    };
    // Two frames: Reveal re-lays out on the frame after a resize.
    const schedule = () => {
      cancelAnimationFrame(frameHandle);
      frameHandle = requestAnimationFrame(() => {
        frameHandle = requestAnimationFrame(measure);
      });
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    observer?.observe(area);
    window.addEventListener('resize', schedule);
    reveal?.on('resize', schedule);
    reveal?.on('ready', schedule);
    return () => {
      cancelAnimationFrame(frameHandle);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      reveal?.off('resize', schedule);
      reveal?.off('ready', schedule);
    };
  }, [reveal, slidesElement]);

  // ── This person's pointer → awareness ─────────────────────────────────────
  const senderRef = useRef<PointerSender | null>(null);
  useEffect(() => {
    if (!session) return;
    const sender = new PointerSender({ send: pointer => session.setPointer(pointer) });
    senderRef.current = sender;
    return () => {
      sender.stop();
      if (senderRef.current === sender) senderRef.current = null;
    };
  }, [session]);

  useEffect(() => {
    const area = rootRef.current?.parentElement;
    const sender = senderRef.current;
    if (!area || !sender) return;
    if (hidden || !slideId) {
      sender.clear();
      return;
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const slides = slidesElement();
      const at = slides
        ? screenToSlide({ x: event.clientX, y: event.clientY }, slides.getBoundingClientRect())
        : null;
      if (at) sender.move({ slide: slideId, ...at });
      else sender.clear();
    };
    const onLeave = () => sender.clear();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sender.clear();
    };
    area.addEventListener('pointermove', onMove, { passive: true });
    area.addEventListener('pointerleave', onLeave);
    area.addEventListener('pointercancel', onLeave);
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      area.removeEventListener('pointermove', onMove);
      area.removeEventListener('pointerleave', onLeave);
      area.removeEventListener('pointercancel', onLeave);
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      // A new slide (or overview) starts with no pointer until the next move.
      sender.clear();
    };
  }, [session, slideId, hidden, slidesElement]);

  // ── Everyone else's pointers on this slide ────────────────────────────────
  useEffect(() => {
    const awareness = session?.awareness;
    if (!session || !awareness || hidden || !slideId) {
      setPointers([]);
      return;
    }
    const motion = new PointerMotion();
    let restTimer: ReturnType<typeof setTimeout> | null = null;
    const filter = {
      localClientId: session.doc.clientID,
      localUserId: session.user.id,
      slideId,
    };
    const refresh = () => {
      if (restTimer) clearTimeout(restTimer);
      restTimer = null;
      const states = awareness.getStates() as Map<number, unknown>;
      motion.update(pointersFromStates(states, { ...filter, max: Number.POSITIVE_INFINITY }));
      const shown = pointersFromStates(states, { ...filter, movedAt: motion.movedAt() });
      setPointers(shown.map(p => ({ ...p, resting: motion.resting(p.clientId, p.agent) })));
      const agents = new Set(shown.filter(p => p.agent).map(p => p.clientId));
      const next = motion.nextRestIn(agents);
      if (next !== null) restTimer = setTimeout(refresh, next + 20);
    };
    refresh();
    awareness.on('change', refresh);
    return () => {
      awareness.off('change', refresh);
      if (restTimer) clearTimeout(restTimer);
    };
  }, [session, slideId, hidden]);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
      data-testid="live-pointers"
      aria-hidden
    >
      {frame &&
        pointers.map(pointer => (
          <PointerArrow
            key={pointer.clientId}
            pointer={pointer}
            at={slideToScreen(pointer, frame)}
            glide={!reducedMotion}
          />
        ))}
    </div>
  );
}

function PointerArrow({
  pointer,
  at,
  glide,
}: {
  pointer: ShownPointer;
  at: { x: number; y: number };
  glide: boolean;
}) {
  // A new arrow appears where it is; it glides only from then on.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const handle = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(handle);
  }, []);
  const { color, name, agent, resting } = pointer;
  return (
    <div
      className="absolute left-0 top-0 will-change-transform"
      style={{
        transform: `translate3d(${at.x}px, ${at.y}px, 0)`,
        transition: placed && glide ? GLIDE : 'none',
        opacity: resting ? 0.45 : 1,
      }}
      data-testid="live-pointer"
      data-name={name}
      data-x={Math.round(pointer.x)}
      data-y={Math.round(pointer.y)}
      data-agent={agent ? 'true' : undefined}
      data-resting={resting ? 'true' : undefined}
    >
      <svg
        width="18"
        height="22"
        viewBox="0 0 18 22"
        className="block -translate-x-px -translate-y-px"
        style={{ filter: 'drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.45))' }}
      >
        <path
          d="M1.5 1.5 L1.5 17.5 L5.6 13.6 L8.6 20.2 L11.4 19 L8.5 12.5 L14.5 12.5 Z"
          fill={color}
          stroke="#ffffff"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="absolute left-3.5 top-[18px] flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4 shadow-md ring-1 ring-white/90 dark:ring-gray-900/70"
        style={{
          backgroundColor: color,
          color: textOnColor(color),
          opacity: resting ? 0 : 1,
          transition: glide ? 'opacity 300ms ease-out' : 'none',
        }}
        data-testid="live-pointer-name"
      >
        {agent && <IconSparkles size={11} stroke={2.5} aria-hidden />}
        {name}
      </span>
    </div>
  );
}
