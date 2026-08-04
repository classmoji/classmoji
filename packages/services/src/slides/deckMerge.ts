/**
 * deckMerge.ts — semantic 3-way merge of deck slides (content-tools plan §3b,
 * Phase 7).
 *
 * Pure functions only: no service imports, no network, no database. Extends
 * the Level-1 3-way walk (deckHtml diffDeckUnits) into a true auto-merge:
 * non-conflicted units of a stale preview are rebased onto fresh main, so an
 * accept only ever stops on genuine same-unit collisions.
 *
 * Merge semantics (a SLIDE is the unit — fields merge atomically per unit,
 * never html-vs-notes within one slide):
 * - changed on one side only → take that side
 * - changed identically on both sides → take either
 * - changed differently on both sides → conflict
 * - added on one side → keep (position from that side's order)
 * - deleted on one side + unchanged on the other → the delete wins
 *   (a move on the other side does NOT protect from the delete — only edits do)
 * - deleted on one side + edited on the other → conflict (null = deleted side)
 * - order: the top-level id sequence and each stack's child sequence are
 *   3-way merged (one side reordered → take it; both reordered differently →
 *   order conflict); stack membership moves are sequence ops
 * - containers (vertical stacks) recurse one level: their own fields merge as
 *   a unit, child slides merge as units, the child sequence merges as a scope.
 *   Delete-vs-edit tests for a container consider its whole subtree; a
 *   container conflict that carries subtrees (delete-vs-edit / structure
 *   change) absorbs its children — no nested conflicts.
 * - the container view is CONFINED: a child that escaped to a different
 *   parent on some side (a cross-scope move) merges independently and is
 *   excluded from its old container's structure detection, comparisons, and
 *   conflict cards. A move-out on one side + a content edit on the other
 *   auto-merges (the edit follows the moved slide); a card can never show a
 *   child whose fate the chooser does not control.
 * - deck-level meta (theme, codeTheme, dark pairs, config, customCss,
 *   extraCss) merges per-field; a field changed differently on both sides
 *   raises the single `__meta__` conflict carrying the double-changed fields.
 *
 * Conflict ids are addressable by the chooser / resolutions:
 *   <slideId>              unit conflict (content / delete_vs_edit / both_added / placement)
 *   __order__              top-level order conflict (id-array sides)
 *   __order__:<stackId>    one stack's child-order conflict (id-array sides)
 *   __meta__               deck-level field conflict (partial-meta sides)
 * Resolving a unit conflict takes the chosen side's version of the unit
 * verbatim (its content, its placement, and — for subtree-carrying conflicts —
 * its children). Resolving an order conflict picks that side's sequence as the
 * backbone (the other side's additions are still woven in).
 */

import {
  canonicalJson,
  dedupeMergedTreeIds,
  mergeIdSequence3,
  type MergeChoice,
} from '../content/merge3.ts';
import type { DeckJson, DeckSlide } from './deckTypes.ts';

export { PreviewResolutionError, indexResolutions } from '../content/merge3.ts';
export type { MergeChoice, MergeResolution } from '../content/merge3.ts';

// ─── Conflict types ──────────────────────────────────────────────────────────

/** Sentinel conflict id for the top-level order; stacks use `__order__:<id>`. */
export const DECK_ORDER_CONFLICT_ID = '__order__';
/** Sentinel conflict id for deck-level meta (theme/config/css) collisions. */
export const DECK_META_CONFLICT_ID = '__meta__';

/** Conflict-id for a stack's child-order conflict. */
export function deckChildOrderConflictId(containerId: string): string {
  return `${DECK_ORDER_CONFLICT_ID}:${containerId}`;
}

/** The deck-level fields merged per-field (everything but `version`/`slides`). */
export type DeckMeta = Pick<
  DeckJson,
  'theme' | 'codeTheme' | 'themeDark' | 'codeThemeDark' | 'config' | 'customCss' | 'extraCss'
>;

const META_FIELDS = [
  'theme',
  'codeTheme',
  'themeDark',
  'codeThemeDark',
  'config',
  'customCss',
  'extraCss',
] as const;

/** A slide changed incompatibly on both sides. null = deleted/absent on that side. */
export interface DeckUnitMergeConflict {
  id: string;
  /** Dotted position, '4' or '4.2' (position in ours, falling back to theirs/base). */
  index: string;
  reason: 'content' | 'delete_vs_edit' | 'both_added' | 'placement';
  base?: DeckSlide;
  ours: DeckSlide | null;
  theirs: DeckSlide | null;
}

/** Both sides reordered a sequence differently (top level or one stack). */
export interface DeckOrderMergeConflict {
  /** `__order__` (top level) or `__order__:<stackId>`. */
  id: string;
  /** '' for the top level; the stack's dotted position otherwise. */
  index: string;
  reason: 'order' | 'child_order';
  base: string[];
  ours: string[];
  theirs: string[];
}

/** Both sides changed the same deck-level field(s) differently. */
export interface DeckMetaMergeConflict {
  id: typeof DECK_META_CONFLICT_ID;
  index: '';
  reason: 'meta';
  /** Only the double-changed fields appear. */
  base: Partial<DeckMeta>;
  ours: Partial<DeckMeta>;
  theirs: Partial<DeckMeta>;
}

export type DeckMergeConflict =
  | DeckUnitMergeConflict
  | DeckOrderMergeConflict
  | DeckMetaMergeConflict;

export interface DeckMergeResult {
  /**
   * The merged deck. Fully authoritative when `conflicts` is empty; while
   * conflicts are pending, conflicted units carry the theirs side (or ours
   * when theirs deleted) provisionally.
   */
  merged: DeckJson;
  conflicts: DeckMergeConflict[];
  /** Unit-level changes (edits/adds/deletes) that merged without a conflict. */
  autoMerged: number;
}

// ─── Indexing / signatures ───────────────────────────────────────────────────

const ROOT = '__root__';

interface UnitEntry {
  slide: DeckSlide;
  parent: string; // ROOT or container id
  index: string; // dotted position
}

interface SideIndex {
  units: Map<string, UnitEntry>;
  rootOrder: string[];
  childOrder: Map<string, string[]>;
}

function indexDeck(deck: DeckJson): SideIndex {
  const units = new Map<string, UnitEntry>();
  const rootOrder: string[] = [];
  const childOrder = new Map<string, string[]>();
  deck.slides.forEach((slide, i) => {
    rootOrder.push(slide.id);
    units.set(slide.id, { slide, parent: ROOT, index: String(i + 1) });
    if (slide.children && slide.children.length > 0) {
      childOrder.set(
        slide.id,
        slide.children.map(child => child.id)
      );
      slide.children.forEach((child, j) => {
        units.set(child.id, { slide: child, parent: slide.id, index: `${i + 1}.${j + 1}` });
      });
    }
  });
  return { units, rootOrder, childOrder };
}

const isContainer = (slide: DeckSlide | undefined): boolean => (slide?.children?.length ?? 0) > 0;

/** A unit's own fields — children are the child units' / child scope's business. */
function contentSig(slide: DeckSlide | undefined): string {
  if (!slide) return 'absent';
  const unitAttrs = slide.attrs ?? {};
  const attrs = Object.keys(unitAttrs)
    .sort()
    .map(key => [key, unitAttrs[key]]);
  return JSON.stringify({
    html: slide.html ?? null,
    notes: slide.notes ?? null,
    hidden: slide.hidden ?? false,
    attrs,
  });
}

/**
 * The unit's subtree restricted to its CONFINED children — used for delete
 * tests on containers and for atomic (structure-change) units. Children that
 * escaped to another parent on some side are excluded: they merge
 * independently, so they must not drag their old container into a conflict
 * (or pad out its cards) on their behalf.
 */
function subtreeSig(slide: DeckSlide | undefined, confined?: ReadonlySet<string>): string {
  if (!slide) return 'absent';
  const children = (slide.children ?? [])
    .filter(child => !confined || confined.has(child.id))
    .map(child => `${child.id}:${contentSig(child)}`);
  return `${contentSig(slide)}|${children.join(',')}`;
}

/** Display copy of a container for a fields-only conflict: children stripped. */
function sansChildren(slide: DeckSlide): DeckSlide {
  const copy = structuredClone(slide);
  delete copy.children;
  return copy;
}

/**
 * Verbatim card/subtree copy restricted to confined children. What a
 * subtree-carrying conflict card shows must be EXACTLY what resolving to that
 * side commits — escaped children have independent fates, so they are
 * stripped from the card just as buildUnit strips them from the resolved
 * subtree.
 */
function cloneConfined(slide: DeckSlide, confined: ReadonlySet<string>): DeckSlide {
  const copy = structuredClone(slide);
  if (copy.children) {
    copy.children = copy.children.filter(child => confined.has(child.id));
    if (copy.children.length === 0) delete copy.children;
  }
  return copy;
}

// ─── merge3Units ─────────────────────────────────────────────────────────────

type Side = 'base' | 'ours' | 'theirs';

interface UnitFate {
  kind: 'drop' | 'keep' | 'conflict';
  /** Which side's fields the merged unit carries ('keep', or provisional for 'conflict'). */
  source?: Side;
  /** Carry the source side's subtree verbatim (atomic / delete-vs-edit containers). */
  verbatimSubtree?: boolean;
  /** This fate contributed to the autoMerged counter (undone if it conflicts later). */
  countedAuto?: boolean;
  conflict?: DeckUnitMergeConflict;
}

/**
 * Semantic 3-way merge of deck slides: base = merge-base, ours = main,
 * theirs = preview. Pure. Zero conflicts ⇒ `merged` is fully auto-merged.
 *
 * @param opts.resolutions - chooser decisions keyed by conflict id; a resolved
 *   conflict is applied (chosen side wins) and not reported.
 */
export function merge3Units(
  base: DeckJson,
  ours: DeckJson,
  theirs: DeckJson,
  opts: { resolutions?: Record<string, MergeChoice> } = {}
): DeckMergeResult {
  const resolutions = opts.resolutions ?? {};
  const sides: Record<Side, SideIndex> = {
    base: indexDeck(base),
    ours: indexDeck(ours),
    theirs: indexDeck(theirs),
  };

  const orderConflicts: DeckOrderMergeConflict[] = [];
  let autoMerged = 0;

  // Deterministic id walk: theirs order first, then ours, then base.
  const seen = new Set<string>();
  const allIds = [
    ...sides.theirs.units.keys(),
    ...sides.ours.units.keys(),
    ...sides.base.units.keys(),
  ].filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const entryOf = (side: Side, id: string) => sides[side].units.get(id);
  const positionOf = (id: string): string =>
    entryOf('ours', id)?.index ?? entryOf('theirs', id)?.index ?? entryOf('base', id)?.index ?? '';

  // ── Phase A: unit fates (content + membership) ──
  const fates = new Map<string, UnitFate>();
  /** Ids that ride verbatim inside a subtree-carrying unit — not independent units. */
  const consumed = new Set<string>();
  /** Ids that were (initially) conflicts — resolved or not (dedupe preference). */
  const conflictedIds = new Set<string>();

  /** Every child id of `id` across all sides. */
  const childIdsOf = (id: string): Set<string> => {
    const childIds = new Set<string>();
    for (const side of ['base', 'ours', 'theirs'] as const) {
      for (const cid of entryOf(side, id)?.slide.children?.map(c => c.id) ?? []) {
        childIds.add(cid);
      }
    }
    return childIds;
  };

  /** Child ids of `id` (across all sides) confined to `id` everywhere they exist. */
  const confinedChildIds = (id: string): string[] =>
    [...childIdsOf(id)].filter(cid =>
      (['base', 'ours', 'theirs'] as const).every(side => {
        const entry = entryOf(side, cid);
        return !entry || entry.parent === id;
      })
    );

  const makeConflict = (
    id: string,
    reason: DeckUnitMergeConflict['reason'],
    oursSlide: DeckSlide | null,
    theirsSlide: DeckSlide | null,
    baseSlide: DeckSlide | undefined,
    verbatimSubtree: boolean,
    confinedSet: ReadonlySet<string>
  ): UnitFate => {
    const strip = (slide: DeckSlide | null): DeckSlide | null =>
      slide == null
        ? null
        : verbatimSubtree
          ? cloneConfined(slide, confinedSet)
          : isContainer(slide)
            ? sansChildren(slide)
            : structuredClone(slide);
    const conflict: DeckUnitMergeConflict = {
      id,
      index: positionOf(id),
      reason,
      ours: strip(oursSlide),
      theirs: strip(theirsSlide),
    };
    if (baseSlide) {
      conflict.base = strip(baseSlide) as DeckSlide;
    }
    return {
      kind: 'conflict',
      source: theirsSlide != null ? 'theirs' : 'ours',
      verbatimSubtree,
      conflict,
    };
  };

  for (const id of allIds) {
    const b = entryOf('base', id);
    const o = entryOf('ours', id);
    const t = entryOf('theirs', id);

    // Confined view (cross-scope moves): a child that escaped to a different
    // parent on some side is merged independently — it is invisible to this
    // unit's structure detection, its comparisons, and its conflict cards.
    // Without this, a moved-out child both rides inside the container's
    // conflict subtree AND gets its own fate, so resolving either side of the
    // container yields the same (card-contradicting) document.
    const confinedSet = new Set(confinedChildIds(id));
    const presentFlags = [b, o, t].filter((e): e is UnitEntry => e != null);
    const containerFlags = presentFlags.map(e =>
      (e.slide.children ?? []).some(child => confinedSet.has(child.id))
    );
    const atomic = containerFlags.some(flag => flag !== containerFlags[0]);
    const anyContainer = containerFlags.some(Boolean);

    // Content comparisons: atomic units compare (and ride) their confined
    // subtrees; delete tests for containers consider the confined subtree.
    const cSig = (e: UnitEntry | undefined) =>
      atomic ? subtreeSig(e?.slide, confinedSet) : contentSig(e?.slide);
    const dSig = (e: UnitEntry | undefined) =>
      anyContainer || atomic ? subtreeSig(e?.slide, confinedSet) : contentSig(e?.slide);

    const autoKeep = (source: Side): UnitFate => {
      autoMerged++;
      return { kind: 'keep', source, verbatimSubtree: atomic, countedAuto: true };
    };
    const autoDrop = (): UnitFate => {
      autoMerged++;
      return { kind: 'drop', countedAuto: true };
    };

    let fate: UnitFate;
    if (b && o && t) {
      const oursChanged = cSig(o) !== cSig(b);
      const theirsChanged = cSig(t) !== cSig(b);
      if (!oursChanged && !theirsChanged) {
        fate = { kind: 'keep', source: 'base', verbatimSubtree: atomic };
      } else if (oursChanged && !theirsChanged) {
        fate = autoKeep('ours');
      } else if (!oursChanged && theirsChanged) {
        fate = autoKeep('theirs');
      } else if (cSig(o) === cSig(t)) {
        fate = autoKeep('ours'); // identical edits on both sides
      } else {
        fate = makeConflict(id, 'content', o.slide, t.slide, b.slide, atomic, confinedSet);
      }
    } else if (b && !o && !t) {
      fate = autoDrop(); // deleted on both sides
    } else if (b && !o && t) {
      // Deleted on ours (main).
      if (dSig(t) === dSig(b)) {
        fate = autoDrop(); // the delete wins over an unchanged (or merely moved) unit
      } else {
        fate = makeConflict(
          id,
          'delete_vs_edit',
          null,
          t.slide,
          b.slide,
          anyContainer || atomic,
          confinedSet
        );
      }
    } else if (b && o && !t) {
      // Deleted on theirs (the preview).
      if (dSig(o) === dSig(b)) {
        fate = autoDrop();
      } else {
        fate = makeConflict(
          id,
          'delete_vs_edit',
          o.slide,
          null,
          b.slide,
          anyContainer || atomic,
          confinedSet
        );
      }
    } else if (!b && o && !t) {
      fate = autoKeep('ours'); // added on main
    } else if (!b && !o && t) {
      fate = autoKeep('theirs'); // added on the preview
    } else {
      // Added on both sides with the same id.
      if (subtreeSig(o!.slide, confinedSet) === subtreeSig(t!.slide, confinedSet)) {
        fate = autoKeep('ours');
      } else {
        fate = makeConflict(id, 'both_added', o!.slide, t!.slide, undefined, true, confinedSet);
      }
    }

    // Apply a chooser resolution to a unit conflict. The verbatimSubtree flag
    // survives the resolution (drops included) so the consumed sweep below
    // still binds the unit's confined children to its fate.
    if (fate.kind === 'conflict') conflictedIds.add(id);
    const choice = resolutions[id];
    if (fate.kind === 'conflict' && choice) {
      const chosen = choice === 'ours' ? fate.conflict!.ours : fate.conflict!.theirs;
      fate =
        chosen == null
          ? { kind: 'drop', verbatimSubtree: fate.verbatimSubtree }
          : { kind: 'keep', source: choice, verbatimSubtree: fate.verbatimSubtree };
    }

    fates.set(id, fate);
  }

  // Subtree-carrying units (atomic structure changes, delete-vs-edit
  // containers, both-added) absorb their confined children: no independent
  // fates, no nested conflicts — the children's fate is the unit's fate.
  for (const [id, fate] of fates) {
    if (fate.verbatimSubtree !== true) continue;
    for (const cid of confinedChildIds(id)) {
      if (cid === id) continue;
      consumed.add(cid);
    }
  }
  for (const cid of consumed) fates.delete(cid);

  // ── Phase B: placement (parent) per surviving unit ──
  const parents = new Map<string, string>();
  for (const [id, fate] of fates) {
    if (fate.kind === 'drop') continue;

    const pb = entryOf('base', id)?.parent;
    const po = entryOf('ours', id)?.parent;
    const pt = entryOf('theirs', id)?.parent;

    if (fate.kind === 'conflict') {
      // Pending conflicts sit at the provisional side's position.
      parents.set(id, (fate.source === 'ours' ? po : pt) ?? pb ?? ROOT);
      continue;
    }

    // Moved to different parents on each side → placement conflict
    // (containers never nest, so this only happens to leaves). Detected
    // before the resolution shortcut so a resolved placement conflict takes
    // the chosen side's parent.
    const bothMovedDifferently = po != null && pt != null && po !== pt && po !== pb && pt !== pb;
    const choice = resolutions[id];

    if (bothMovedDifferently) {
      if (fate.countedAuto) autoMerged--; // its content change no longer counts as clean
      conflictedIds.add(id);
      if (choice) {
        // Resolved placement conflict: the chosen side's unit verbatim —
        // content AND position.
        fates.set(id, { kind: 'keep', source: choice });
        parents.set(id, (choice === 'ours' ? po : pt)!);
      } else {
        const o = entryOf('ours', id)!;
        const t = entryOf('theirs', id)!;
        const b = entryOf('base', id);
        // Placement conflicts only happen to leaves (containers never nest),
        // so the confined set is irrelevant to the fields-only cards.
        fates.set(id, makeConflict(id, 'placement', o.slide, t.slide, b?.slide, false, new Set()));
        parents.set(id, pt!);
      }
      continue;
    }

    if (choice) {
      // A resolved conflict (content or delete-vs-edit) takes the chosen
      // side's placement too.
      parents.set(id, (choice === 'ours' ? po : pt) ?? po ?? pt ?? pb ?? ROOT);
      continue;
    }

    if (po != null && pt != null) {
      // po === pt → unmoved/moved identically; po === pb → theirs moved it;
      // pt === pb → ours moved it.
      parents.set(id, po === pt ? po : po === pb ? pt : po);
    } else {
      parents.set(id, po ?? pt ?? pb ?? ROOT);
    }
  }

  // ── Phase C: sequence merges per scope (root + surviving stacks) ──
  const survivors = new Set(
    [...fates.entries()].filter(([, fate]) => fate.kind !== 'drop').map(([id]) => id)
  );

  // A surviving unit is a merged-doc container when any side has it as a
  // container (stable, since atomic units ride verbatim and skip scopes).
  const scopeContainers = [...survivors].filter(id => {
    const fate = fates.get(id)!;
    if (fate.verbatimSubtree) return false;
    return (['base', 'ours', 'theirs'] as const).some(side =>
      isContainer(entryOf(side, id)?.slide)
    );
  });

  const scopeOrders = new Map<string, string[]>();
  const scopeSet = new Set(scopeContainers);
  const scopes: string[] = [ROOT, ...scopeContainers];
  for (const scope of scopes) {
    const seqOf = (side: Side): string[] =>
      scope === ROOT ? sides[side].rootOrder : (sides[side].childOrder.get(scope) ?? []);
    const members = new Set([...survivors].filter(id => id !== scope && parents.get(id) === scope));
    // A member whose parent is not an actual scope falls back to the root
    // scope, appended at the end (rare: its container was resolved away, or
    // rides verbatim and cannot admit independent children).
    if (scope === ROOT) {
      for (const id of survivors) {
        const parent = parents.get(id);
        if (parent !== ROOT && parent != null && !scopeSet.has(parent) && !members.has(id)) {
          members.add(id);
        }
      }
    }

    const conflictId = scope === ROOT ? DECK_ORDER_CONFLICT_ID : deckChildOrderConflictId(scope);
    const result = mergeIdSequence3(
      seqOf('base'),
      seqOf('ours'),
      seqOf('theirs'),
      members,
      resolutions[conflictId]
    );
    const order = result.conflict ? result.provisional : result.order;
    if (result.conflict) {
      orderConflicts.push({
        id: conflictId,
        index: scope === ROOT ? '' : positionOf(scope),
        reason: scope === ROOT ? 'order' : 'child_order',
        base: result.base,
        ours: result.ours,
        theirs: result.theirs,
      });
    }
    // Safety net: a member that appears in no side sequence for this scope
    // (its container was resolved away) still must land somewhere — append.
    for (const id of members) {
      if (!order.includes(id)) order.push(id);
    }
    scopeOrders.set(scope, order);
  }

  // Unit conflicts in walk order, then order sentinels, then __meta__ (below).
  const conflicts: DeckMergeConflict[] = [];
  for (const id of allIds) {
    const fate = fates.get(id);
    if (fate?.kind === 'conflict' && fate.conflict) conflicts.push(fate.conflict);
  }
  conflicts.push(...orderConflicts);

  // ── Phase D: assemble the merged deck ──
  const buildUnit = (id: string): DeckSlide => {
    const fate = fates.get(id)!;
    const source: Side = fate.source ?? 'base';
    const src = entryOf(source, id)?.slide ?? entryOf('base', id)!.slide;
    const clone = structuredClone(src);
    if (fate.verbatimSubtree) {
      // Subtree rides verbatim, minus children that live independently.
      if (clone.children) {
        clone.children = clone.children.filter(child => consumed.has(child.id));
        if (clone.children.length === 0) delete clone.children;
      }
      return clone;
    }
    delete clone.children;
    const childOrder = scopeOrders.get(id);
    if (childOrder && childOrder.length > 0) {
      clone.children = childOrder.map(buildUnit);
    }
    return clone;
  };

  const rootOrder = scopeOrders.get(ROOT) ?? [];
  const mergedSlides = rootOrder.map(buildUnit);

  // Final safety assertion: no id may appear twice in the assembled document.
  // Unreachable through the confined-view machinery above, but kept as a
  // cheap last line of defense (a duplicate committed to main corrupts the
  // deck for every future merge). Preference goes to the copy inside a
  // conflict unit's subtree — that copy is what the chooser card showed.
  const duplicateIds = dedupeMergedTreeIds(mergedSlides, conflictedIds, {
    dropEmptyChildren: true,
  });
  if (duplicateIds.length > 0) {
    console.warn(
      `[deckMerge] merged deck carried duplicate slide id(s) ${duplicateIds.join(', ')} — ` +
        'kept the conflict-resolution copy and dropped the stale one(s)'
    );
  }

  // ── Meta: per-field 3-way ──
  const merged: DeckJson = {
    version: 1,
    theme: 'white',
    codeTheme: 'github',
    slides: mergedSlides,
  };
  const metaConflict: DeckMetaMergeConflict = {
    id: DECK_META_CONFLICT_ID,
    index: '',
    reason: 'meta',
    base: {},
    ours: {},
    theirs: {},
  };
  const metaChoice = resolutions[DECK_META_CONFLICT_ID];
  for (const field of META_FIELDS) {
    const bVal = base[field];
    const oVal = ours[field];
    const tVal = theirs[field];
    const oursChanged = canonicalJson(oVal) !== canonicalJson(bVal);
    const theirsChanged = canonicalJson(tVal) !== canonicalJson(bVal);
    let value: DeckMeta[typeof field];
    if (!oursChanged && !theirsChanged) value = bVal as DeckMeta[typeof field];
    else if (oursChanged && !theirsChanged) value = oVal as DeckMeta[typeof field];
    else if (!oursChanged && theirsChanged) value = tVal as DeckMeta[typeof field];
    else if (canonicalJson(oVal) === canonicalJson(tVal)) value = oVal as DeckMeta[typeof field];
    else if (metaChoice) {
      value = (metaChoice === 'ours' ? oVal : tVal) as DeckMeta[typeof field];
    } else {
      // Double-changed → the single __meta__ conflict; theirs provisionally.
      (metaConflict.base as Record<string, unknown>)[field] = bVal;
      (metaConflict.ours as Record<string, unknown>)[field] = oVal;
      (metaConflict.theirs as Record<string, unknown>)[field] = tVal;
      value = tVal as DeckMeta[typeof field];
    }
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[field] = structuredClone(value);
    }
  }
  if (Object.keys(metaConflict.ours).length > 0) {
    conflicts.push(metaConflict);
  }

  return { merged, conflicts, autoMerged };
}
