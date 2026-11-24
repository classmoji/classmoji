import { prefersReducedMotion } from './unlockEffects.ts';

/**
 * The burst a tick box gives when the reader ticks it on: four short rays fan
 * upward from the box, slide outward, shrink to a point and fade (400 ms).
 * Plain DOM and the Web Animations API, no React: a fixed SVG layer on <body>,
 * centred on the box, removed once its rays are done.
 *
 * Fired by the reader's own tick, on a checkable heading's box
 * (sectionCheckbox.ts) and a student check list item (personalCheckListItem.ts).
 * Never on untick, never from an inert box ("View as"), never when the reader
 * prefers reduced motion. Drawn in the burst colour (`--pg-burst`: the
 * reader's check colour, lighter in dark mode).
 */

const NS = 'http://www.w3.org/2000/svg';
/** Degrees, 0 = right, counter-clockwise (so "up" is −y on screen). */
const ANGLES = [45, 80, 115, 150];
const SIZE = 60;
const DURATION = 400;
const EASING = 'cubic-bezier(.33,1,.68,1)';

export interface BurstRay {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** How far the ray slides outward over the burst. */
  dx: number;
  dy: number;
}

/**
 * The rays in a `size`×`size` box: each from 10% to 25% of the size out from
 * the centre, sliding a quarter of the size further out.
 */
export function burstRays(size: number = SIZE): BurstRay[] {
  const c = size / 2;
  return ANGLES.map(deg => {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      x1: c + size * 0.1 * cos,
      y1: c - size * 0.1 * sin,
      x2: c + size * 0.25 * cos,
      y2: c - size * 0.25 * sin,
      dx: (size / 4) * cos,
      dy: (-size / 4) * sin,
    };
  });
}

/**
 * Play the burst on `anchor` (the box just ticked on). Returns a promise that
 * settles when the burst is gone, or null when none plays.
 */
export function tickBurst(anchor: Element): Promise<void> | null {
  if (
    typeof document === 'undefined' ||
    typeof Element.prototype.animate !== 'function' ||
    prefersReducedMotion()
  ) {
    return null;
  }
  const rect = anchor.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const style = getComputedStyle(anchor);
  const color =
    style.getPropertyValue('--pg-burst').trim() ||
    style.getPropertyValue('--pg-primary').trim() ||
    'currentColor';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'pg-tick-burst');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.style.cssText =
    `position:fixed;left:${x - SIZE / 2}px;top:${y - SIZE / 2}px;` +
    `width:${SIZE}px;height:${SIZE}px;pointer-events:none;overflow:visible;` +
    `z-index:2147483647;color:${color}`;

  const animations = burstRays().map(ray => {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(ray.x1));
    line.setAttribute('y1', String(ray.y1));
    line.setAttribute('x2', String(ray.x2));
    line.setAttribute('y2', String(ray.y2));
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'square');
    line.setAttribute('pathLength', '1');
    svg.appendChild(line);
    // The inner end catches up with the outer end while the ray slides out.
    return line.animate(
      [
        { strokeDasharray: '1 1', strokeDashoffset: 0, transform: 'translate(0,0)', opacity: 1 },
        {
          strokeDasharray: '1 1',
          strokeDashoffset: -1,
          transform: `translate(${ray.dx}px,${ray.dy}px)`,
          opacity: 0,
        },
      ],
      { duration: DURATION, easing: EASING, fill: 'forwards' }
    );
  });
  document.body.appendChild(svg);

  // Gone when the rays finish, are cancelled, or (a hidden tab holds them)
  // shortly after they should have.
  return new Promise<void>(resolve => {
    const remove = () => {
      window.clearTimeout(fallback);
      svg.remove();
      resolve();
    };
    const fallback = window.setTimeout(remove, DURATION + 200);
    Promise.all(animations.map(animation => animation.finished)).then(remove, remove);
  });
}
