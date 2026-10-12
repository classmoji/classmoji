/**
 * The glass of a locked section: its cracks (drawn in as a hold progresses)
 * and its shatter (when the hold completes). Plain DOM and SVG geometry, no
 * React: the cracks are path strings the card renders, the shatter is a layer
 * on <body> so the block can change under it.
 *
 * Seeded per block id, so a section cracks the same way every time.
 */

/** mulberry32 seeded from a string. */
export function seededRandom(seed: string): () => number {
  let a = [...seed].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Crack {
  d: string;
  /** Progress (0–1) at which this crack starts to draw. */
  start: number;
}

/**
 * Cracks radiating from (ox, oy) across a W×H stage: ten jagged rays, some
 * with a branch, and two rings of chords between neighbouring rays late in
 * the hold.
 */
export function buildCracks(seed: string, W: number, H: number, ox: number, oy: number): Crack[] {
  const r = seededRandom(seed);
  const rad = 34;
  const out: Crack[] = [];
  const ray = (x: number, y: number, ang: number, len: number, segs: number, start: number) => {
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    let px = x;
    let py = y;
    const pts: Array<[number, number, number]> = [];
    for (let s = 0; s < segs; s++) {
      ang += (r() - 0.5) * 0.7;
      const L = (len / segs) * (0.7 + r() * 0.6);
      px += Math.cos(ang) * L;
      py += Math.sin(ang) * L;
      d += ` L${px.toFixed(1)} ${py.toFixed(1)}`;
      pts.push([px, py, ang]);
    }
    out.push({ d, start });
    return pts;
  };
  const N = 10;
  const angs: number[] = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2 + (r() - 0.5) * 0.5;
    angs.push(ang);
    const reach = Math.hypot(Math.max(ox, W - ox), Math.max(oy, H - oy)) * (0.55 + r() * 0.5);
    const sx = ox + Math.cos(ang) * rad;
    const sy = oy + Math.sin(ang) * rad;
    const pts = ray(sx, sy, ang, reach, 4 + Math.floor(r() * 2), r() * 0.35);
    if (r() < 0.55) {
      const p = pts[1 + Math.floor(r() * (pts.length - 2))];
      ray(
        p[0],
        p[1],
        p[2] + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.5),
        reach * 0.35,
        3,
        0.45 + r() * 0.3
      );
    }
  }
  [1.55, 2.4].forEach((k, ring) =>
    angs.forEach((a, i) => {
      if (r() < 0.3) return;
      const b = angs[(i + 1) % N];
      const R = rad * k * (0.9 + r() * 0.2);
      const p0 = [ox + Math.cos(a) * R, oy + Math.sin(a) * R];
      const p1 = [ox + Math.cos(b) * R, oy + Math.sin(b) * R];
      const mx = (p0[0] + p1[0]) / 2 + (r() - 0.5) * 6;
      const my = (p0[1] + p1[1]) / 2 + (r() - 0.5) * 6;
      out.push({
        d: `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} L${mx.toFixed(1)} ${my.toFixed(1)} L${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`,
        start: 0.5 + ring * 0.15 + r() * 0.15,
      });
    })
  );
  return out;
}

/** How far one crack has drawn at hold progress `p` (0 = none, 1 = whole). */
export function crackProgress(p: number, start: number): number {
  return Math.max(0, Math.min(1, ((p - start) / (1 - start)) * 1.15));
}

/**
 * Break the glass over `stage`: 14 clip-path shards (a jittered 4×3 grid, two
 * cells split into triangles) fly out and fall from (ox, oy), on a layer
 * appended to <body> that removes itself. Returns the layer's lifetime in ms.
 */
export function shatterGlass(stage: HTMLElement, seed: string, ox: number, oy: number): number {
  const rect = stage.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;
  const layer = document.createElement('div');
  layer.className = 'pg-shard-layer';
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, {
    left: `${rect.left + window.scrollX}px`,
    top: `${rect.top + window.scrollY}px`,
    width: `${W}px`,
    height: `${H}px`,
  });
  const cols = 4;
  const rows = 3;
  const rnd = seededRandom(`${seed}shards`);
  const P: Array<[number, number]> = [];
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      const jx = x > 0 && x < cols ? (rnd() - 0.5) * (W / cols) * 0.55 : 0;
      const jy = y > 0 && y < rows ? (rnd() - 0.5) * (H / rows) * 0.55 : 0;
      P.push([(x * W) / cols + jx, (y * H) / rows + jy]);
    }
  }
  const at = (x: number, y: number) => P[y * (cols + 1) + x];
  const polys: Array<Array<[number, number]>> = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const q = [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)];
      if ((x + y * 3) % 6 === 1) polys.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
      else polys.push(q);
    }
  }
  const maxD = Math.hypot(W, H) / 2;
  let longest = 0;
  for (const poly of polys) {
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const shard = document.createElement('div');
    shard.className = 'pg-shard';
    shard.style.clipPath = `polygon(${poly.map(p => `${p[0].toFixed(1)}px ${p[1].toFixed(1)}px`).join(',')})`;
    shard.style.transformOrigin = `${cx}px ${cy}px`;
    shard.style.setProperty('--pg-shard-angle', `${100 + rnd() * 50}deg`);
    layer.appendChild(shard);
    const dirX = (cx - ox) / W;
    const dirY = (cy - oy) / H;
    const dx = dirX * 90 + (rnd() - 0.5) * 30;
    const dy = 110 + rnd() * 90 + cy * 0.3;
    const rot = (rnd() - 0.5) * 50;
    const delay = (Math.hypot(cx - ox, cy - oy) / maxD) * 90;
    const duration = 640 + rnd() * 120;
    longest = Math.max(longest, delay + duration);
    shard.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        {
          offset: 0.18,
          transform: `translate(${dx * 0.18}px, ${dirY * 14 - 8}px) rotate(${rot * 0.15}deg)`,
          opacity: 1,
        },
        { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration, delay, easing: 'cubic-bezier(.5,0,.85,.55)', fill: 'both' }
    );
  }
  document.body.appendChild(layer);
  const life = Math.ceil(longest) + 60;
  window.setTimeout(() => layer.remove(), life);
  return life;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const unlockedFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Oct 12, 3:41 PM" (reader's zone), or '' for an unreadable time. */
export function formatUnlockedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : unlockedFormat.format(date);
}
