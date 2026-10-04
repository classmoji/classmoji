/**
 * Deck JSON → deckOps: the op list that turns `before` into `after`, in the
 * `deckOps.ts` vocabulary the collab server's `/internal/deck/:id/ops`
 * accepts. Used to apply a merged preview to the live deck: the server
 * replays the ops id-aware, so people editing other slides are untouched.
 *
 * Inserted slides get ids minted by the server (the vocabulary has no way to
 * name them), so `after`'s ids for new slides are not kept. Anything the
 * vocabulary cannot express returns null:
 *   - a slide that changes between leaf and stack;
 *   - a new stack holding existing slides;
 *   - a new slide, or a slide from elsewhere, at the very top of an existing
 *     stack (positions are "after <id>" or the deck's start/end);
 *   - deck-level fields other than theme and code theme.
 *
 * Pure. Pass `verify` (e.g. `(deck, ops) => applyDeckOps(deck, ops).deck`) to
 * have the plan replayed and compared; a mismatch returns null.
 */
import type { DeckJson, DeckOp, DeckSlide } from '@classmoji/services/slides';

const MAX_OPS = 400;

interface Indexed {
  slide: DeckSlide;
  parent: string | null;
  container: boolean;
}

function index(deck: DeckJson): Map<string, Indexed> {
  const out = new Map<string, Indexed>();
  for (const slide of deck.slides) {
    const container = slide.children !== undefined;
    out.set(slide.id, { slide, parent: null, container });
    for (const child of slide.children ?? []) {
      out.set(child.id, { slide: child, parent: slide.id, container: false });
    }
  }
  return out;
}

const sameAttrs = (a?: Record<string, string>, b?: Record<string, string>): boolean => {
  const x = a ?? {};
  const y = b ?? {};
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(k => y[k] === x[k]);
};

/** Indices on a longest run of increasing `rank` (kept in place). */
function stayRun(seq: string[], rank: Map<string, number>, pinned?: string): Set<string> {
  let items = seq.filter(id => rank.has(id));
  if (pinned && items.includes(pinned)) {
    const pinRank = rank.get(pinned) as number;
    const at = items.indexOf(pinned);
    items = items.filter((id, i) =>
      id === pinned
        ? true
        : i < at
          ? (rank.get(id) as number) < pinRank
          : (rank.get(id) as number) > pinRank
    );
  }
  const tails: number[] = [];
  const prev = new Array<number>(items.length).fill(-1);
  for (let i = 0; i < items.length; i++) {
    const r = rank.get(items[i]) as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((rank.get(items[tails[mid]]) as number) < r) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<string>();
  let at = tails.length ? tails[tails.length - 1] : -1;
  while (at !== -1) {
    out.add(items[at]);
    at = prev[at];
  }
  return out;
}

class Inexpressible extends Error {}

function newSlideSpec(slide: DeckSlide, allowChildren: boolean, known: Map<string, Indexed>) {
  const spec: Record<string, unknown> = {};
  if (slide.children !== undefined) {
    if (!allowChildren || slide.children.length === 0) throw new Inexpressible();
    spec.children = slide.children.map(child => {
      if (known.has(child.id)) throw new Inexpressible(); // existing slide in a new stack
      return newSlideSpec(child, false, known);
    });
  } else {
    spec.html = slide.html ?? '';
  }
  if (slide.notes) spec.notes = slide.notes;
  if (slide.hidden) spec.hidden = true;
  if (slide.attrs && Object.keys(slide.attrs).length > 0) spec.attrs = { ...slide.attrs };
  return spec;
}

export interface DeckOpsBetweenOptions {
  /** Replay `ops` onto `before` (e.g. applyDeckOps) to check the plan. */
  verify?: (before: DeckJson, ops: DeckOp[]) => DeckJson;
}

export function deckOpsBetween(
  before: DeckJson,
  after: DeckJson,
  opts: DeckOpsBetweenOptions = {}
): DeckOp[] | null {
  try {
    const ops = planOps(before, after);
    if (ops.length > MAX_OPS) return null;
    if (opts.verify && ops.length > 0) {
      const replayed = opts.verify(before, ops);
      if (deckSignature(replayed, before) !== deckSignature(after, before)) return null;
    }
    return ops;
  } catch (err) {
    if (err instanceof Inexpressible) return null;
    throw err;
  }
}

function planOps(before: DeckJson, after: DeckJson): DeckOp[] {
  const ops: DeckOp[] = [];
  const was = index(before);
  const now = index(after);

  // Deck-level: theme and code theme only.
  for (const key of ['themeDark', 'codeThemeDark', 'config', 'customCss', 'extraCss'] as const) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    // set_theme clears the dark pair itself; anything else is not expressible.
    const clearedByTheme =
      (key === 'themeDark' && after.themeDark === undefined && after.theme !== before.theme) ||
      // set_theme drops the starter template's css (applyDeckOps starterCustomCss).
      (key === 'customCss' && after.customCss === undefined && after.theme !== before.theme) ||
      (key === 'codeThemeDark' &&
        after.codeThemeDark === undefined &&
        after.codeTheme !== before.codeTheme);
    if (!clearedByTheme) throw new Inexpressible();
  }
  if (after.theme !== before.theme || after.codeTheme !== before.codeTheme) {
    ops.push({
      op: 'set_theme',
      ...(after.theme !== before.theme ? { theme: after.theme } : {}),
      ...(after.codeTheme !== before.codeTheme ? { code_theme: after.codeTheme } : {}),
    });
  }

  // 1. Content updates.
  for (const [id, next] of now) {
    const prev = was.get(id);
    if (!prev) continue;
    if (prev.container !== next.container) throw new Inexpressible();
    const op: Extract<DeckOp, { op: 'update' }> = { op: 'update', id };
    let changed = false;
    if (!next.container && (prev.slide.html ?? '') !== (next.slide.html ?? '')) {
      op.html = next.slide.html ?? '';
      changed = true;
    }
    if ((prev.slide.notes ?? '') !== (next.slide.notes ?? '')) {
      op.notes = next.slide.notes ? next.slide.notes : null;
      changed = true;
    }
    if (Boolean(prev.slide.hidden) !== Boolean(next.slide.hidden)) {
      op.hidden = Boolean(next.slide.hidden);
      changed = true;
    }
    if (!sameAttrs(prev.slide.attrs, next.slide.attrs)) {
      op.attrs =
        next.slide.attrs && Object.keys(next.slide.attrs).length > 0
          ? { ...next.slide.attrs }
          : null;
      changed = true;
    }
    if (changed) ops.push(op);
  }

  // 2. Existing slides into place, scope by scope (top level first, so a
  //    stack is where it belongs before its children are arranged).
  const scopes: Array<{ scope: string | null; seq: DeckSlide[] }> = [
    { scope: null, seq: after.slides },
    ...after.slides
      .filter(s => s.children !== undefined && was.has(s.id))
      .map(s => ({ scope: s.id, seq: s.children ?? [] })),
  ];
  for (const { scope, seq } of scopes) {
    const target = seq.map(s => s.id).filter(id => was.has(id));
    const currentScope =
      scope === null
        ? before.slides.map(s => s.id)
        : (before.slides.find(s => s.id === scope)?.children ?? []).map(s => s.id);
    const rank = new Map<string, number>();
    target.forEach((id, i) => rank.set(id, i));
    const inScope = currentScope.filter(id => rank.has(id));
    // In a stack, the first slide cannot be placed — it has to stay put.
    const stay = stayRun(inScope, rank, scope === null ? undefined : target[0]);
    if (scope !== null && target.length > 0 && !stay.has(target[0])) throw new Inexpressible();
    let prevId: string | null = null;
    for (const id of target) {
      if (!stay.has(id)) {
        ops.push(
          prevId
            ? { op: 'move', id, position: { after: prevId } }
            : { op: 'move', id, position: { at: 'start' } }
        );
      }
      prevId = id;
    }
  }

  // 3. New slides, in runs anchored after their preceding existing sibling.
  const insertRuns = (scope: string | null, seq: DeckSlide[]) => {
    let anchor: string | null = null;
    let run: DeckSlide[] = [];
    const flush = () => {
      if (run.length === 0) return;
      for (let i = 0; i < run.length; i += 20) {
        const slides = run
          .slice(i, i + 20)
          .map(s => newSlideSpec(s, scope === null, was)) as Extract<
          DeckOp,
          { op: 'insert' }
        >['slides'];
        if (anchor) ops.push({ op: 'insert', slides, position: { after: anchor } });
        else if (scope === null) ops.push({ op: 'insert', slides, position: { at: 'start' } });
        else throw new Inexpressible();
        // The next chunk can only follow the previous one by anchoring on the
        // same sibling, which would reverse them; refuse very long runs.
        if (i + 20 < run.length) throw new Inexpressible();
      }
      run = [];
    };
    for (const slide of seq) {
      if (was.has(slide.id)) {
        flush();
        anchor = slide.id;
      } else {
        run.push(slide);
      }
    }
    flush();
  };
  insertRuns(null, after.slides);
  for (const slide of after.slides) {
    if (slide.children !== undefined && was.has(slide.id)) insertRuns(slide.id, slide.children);
  }

  // 4. Deletes last (a slide dragged out of a deleted stack has left it).
  for (const [id, prev] of was) {
    if (now.has(id)) continue;
    if (prev.parent !== null && !now.has(prev.parent)) continue; // goes with its stack
    ops.push({ op: 'delete', id });
  }
  return ops;
}

/**
 * A deck's content with ids of slides not in `known` replaced by their
 * position (inserted slides get server-minted ids).
 */
function deckSignature(deck: DeckJson, known: DeckJson): string {
  const knownIds = index(known);
  const sig = (slide: DeckSlide): unknown => ({
    id: knownIds.has(slide.id) ? slide.id : '*',
    html: slide.children !== undefined ? null : (slide.html ?? ''),
    notes: slide.notes || null,
    hidden: Boolean(slide.hidden),
    attrs: Object.entries(slide.attrs ?? {}).sort(),
    children: slide.children?.map(sig) ?? null,
  });
  return JSON.stringify({
    theme: deck.theme,
    codeTheme: deck.codeTheme,
    slides: deck.slides.map(sig),
  });
}
