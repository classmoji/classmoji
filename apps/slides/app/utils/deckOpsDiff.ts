/**
 * deckOpsDiff.ts — client-side diff-at-save for the slides editor.
 *
 * The editor no longer posts whole documents on the happy path: at save time
 * it diffs its current DOM state against a BASELINE snapshot (captured at
 * edit entry and refreshed after every successful save) and posts granular
 * ops + the base token. Untouched slides are never transmitted, which kills
 * browser-serialization phantom conflicts structurally: the server replays
 * the ops onto the base (`theirs = applyDeckOps(base, ops)`), so anything the
 * diff didn't touch is byte-identical to base by construction.
 *
 * Two layers:
 *  - `extractDeckSnapshot` (DOM): parses a document/wrapper string into a
 *    canonical section list. BOTH sides (the server-generated baseline and
 *    the getCurrentContent post) run through the same parser + cleanup in the
 *    same browser, so per-id string comparison is safe — both sides are
 *    same-DOM serializations.
 *  - `diffDeckSnapshots` (pure, unit-tested): plans ops (update / insert /
 *    move / delete / reorder), then SIMULATES them against the base and
 *    verifies the result matches the current snapshot. Anything the op
 *    vocabulary cannot express — or any planner miss the simulation catches —
 *    returns null, and the caller falls back to the existing whole-document
 *    save (the 7.5 merge path, unchanged).
 *
 * The attribute cleanup here mirrors the server parser's runtime-cruft strip
 * (packages/services/src/slides/deckHtml.ts stripRuntimeCruft): update-op
 * attrs land verbatim in deck.json, so the client must clean exactly what
 * parseSlidesFragment would have cleaned.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiffSection {
  /** data-cm-id, or null for sections created this session. */
  id: string | null;
  /** Inner html minus notes asides; null for stack containers. */
  html: string | null;
  /** Concatenated notes-aside inner html; null when the slide has no notes. */
  notes: string | null;
  hidden: boolean;
  /** Cleaned attributes (data-cm-id / data-hidden / runtime cruft excluded). */
  attrs: Record<string, string>;
  /** Child slides for stack containers; null for leaves. */
  children: DiffSection[] | null;
}

export interface DeckSnapshot {
  theme: string;
  codeTheme: string;
  sections: DiffSection[];
}

export type DeckDiffPosition = { after: string } | { at: 'start' | 'end' };

export interface NewSlideSpec {
  html?: string;
  notes?: string;
  hidden?: boolean;
  attrs?: Record<string, string>;
  children?: NewSlideSpec[];
}

/** Structural mirror of the server op vocabulary (deckOps deckOpSchema). */
export type DeckDiffOp =
  | {
      op: 'update';
      id: string;
      html?: string;
      /** Empty string removes the notes (server contract). */
      notes?: string;
      hidden?: boolean;
      /** null clears all extra attributes. */
      attrs?: Record<string, string> | null;
    }
  | { op: 'insert'; slides: NewSlideSpec[]; position: DeckDiffPosition }
  | { op: 'move'; id: string; position: DeckDiffPosition }
  | { op: 'delete'; id: string }
  | { op: 'reorder'; order: string[] };

export type DocumentParser = (html: string) => Document;

// Server-schema limits — anything over them bails to the whole-doc save.
const MAX_HTML = 200_000;
const MAX_NOTES = 50_000;
const MAX_INSERT_GROUP = 20;
const MAX_OPS = 400;

// ─── Extraction (DOM layer) ──────────────────────────────────────────────────

/** Runtime paint the Reveal viewer/editor leaves on sections (server list). */
const CRUFT_CLASSES = new Set([
  'editing-mode',
  'slide-hidden',
  'stack',
  'present',
  'past',
  'future',
]);

/** Mirror of getCurrentContent's cleanup, applied to BOTH diff sides. */
function cleanupContainer(container: Element): void {
  // Runtime contenteditable never persists.
  container.querySelectorAll('[contenteditable]').forEach(el => {
    el.removeAttribute('contenteditable');
  });

  // Code blocks: flatten to escaped plain text, drop hljs (idempotent — the
  // same normalization the editor applies on load and save, and the server
  // applies in normalizeSlideHtml).
  container.querySelectorAll('pre code').forEach(codeEl => {
    const plainText = codeEl.textContent || '';
    const escaped = plainText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    codeEl.innerHTML = escaped;
    codeEl.classList.remove('hljs');
    if ((codeEl.getAttribute('class') ?? '') === '') codeEl.removeAttribute('class');
  });

  // Sandpack blocks: rebuild sl-block-content to the canonical embed shape
  // (same rebuild getCurrentContent performs — running it on the baseline too
  // keeps the two sides byte-comparable).
  container.querySelectorAll('.sl-block[data-block-type="sandpack"]').forEach(block => {
    const embed = block.querySelector('.sandpack-embed') as HTMLElement | null;
    const scriptTag = embed?.querySelector('script[data-sandpack-files]');
    if (!embed || !scriptTag) {
      block.remove();
      return;
    }
    const filesJson = scriptTag.textContent ?? '';
    const template = embed.dataset.template || 'vanilla';
    const theme = embed.dataset.theme || 'auto';
    const layout = embed.dataset.layout || 'preview-right';
    const { showTabs, showLineNumbers, showConsole, readOnly, editorWidth } = embed.dataset;

    const contentDiv = block.querySelector('.sl-block-content');
    if (contentDiv) {
      let dataAttrs = `data-template="${template}" data-theme="${theme}" data-layout="${layout}"`;
      if (showTabs === 'false') dataAttrs += ' data-show-tabs="false"';
      if (showLineNumbers === 'false') dataAttrs += ' data-show-line-numbers="false"';
      if (showConsole === 'true') dataAttrs += ' data-show-console="true"';
      if (readOnly === 'true') dataAttrs += ' data-read-only="true"';
      if (editorWidth && editorWidth !== '50') dataAttrs += ` data-editor-width="${editorWidth}"`;
      const safeJson = filesJson.replace(/<\/script>/gi, '<\\/script>');
      contentDiv.innerHTML = `<div class="sandpack-embed" ${dataAttrs}><script type="application/json" data-sandpack-files>${safeJson}</script></div>`;
    }
  });

  // Reveal runtime position classes.
  container.querySelectorAll('.present, .past, .future').forEach(el => {
    el.classList.remove('present', 'past', 'future');
    if ((el.getAttribute('class') ?? '') === '') el.removeAttribute('class');
  });

  // Reveal fragment runtime paint (`visible` / `current-fragment`) is added as
  // the presenter steps through fragments — never authored, must never persist,
  // or a merely-VIEWED slide reads as edited. `fragment` itself stays.
  container.querySelectorAll('.fragment').forEach(el => {
    el.classList.remove('visible', 'current-fragment');
  });
}

/**
 * Cleaned attribute record for a section — mirrors the server parser's
 * stripRuntimeCruft + attr snapshot (data-cm-id/data-hidden excluded, event
 * handlers dropped, cruft classes filtered, display style stripped).
 */
function cleanSectionAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    const value = attr.value;
    if (name === 'data-cm-id' || name === 'data-hidden') continue;
    if (/^on/i.test(name)) continue; // event handlers never persist
    if (name === 'aria-hidden' || name === 'hidden') continue; // runtime paint
    if (name === 'class') {
      const kept = value.split(/\s+/).filter(c => c !== '' && !CRUFT_CLASSES.has(c));
      if (kept.length > 0) attrs['class'] = kept.join(' ');
      continue;
    }
    if (name === 'style') {
      // Remove just the `display` property, keep other inline styles —
      // EXACT server join format: 'p1; p2;'.
      const props = value
        .split(';')
        .map(p => p.trim())
        .filter(p => p !== '' && !/^display\s*:/i.test(p));
      if (props.length > 0) attrs['style'] = props.join('; ') + ';';
      continue;
    }
    attrs[name] = value;
  }
  return attrs;
}

/** One section element → DiffSection; null on inexpressible nesting. */
function sectionToDiff(el: Element, allowChildren: boolean): DiffSection | null {
  const childSections = Array.from(el.children).filter(
    child => child.tagName.toLowerCase() === 'section'
  );
  const isContainer = childSections.length > 0;
  if (isContainer && !allowChildren) return null; // >2 nesting levels

  // Children first: their recursion removes THEIR notes asides, so any aside
  // left whose closest section is this element belongs to this section.
  let children: DiffSection[] | null = null;
  if (isContainer) {
    children = [];
    for (const child of childSections) {
      const childSection = sectionToDiff(child, false);
      if (!childSection) return null;
      children.push(childSection);
    }
  }

  const asides = Array.from(el.querySelectorAll('aside')).filter(
    aside => aside.classList.contains('notes') && aside.closest('section') === el
  );
  const notes = asides.length > 0 ? asides.map(aside => aside.innerHTML).join('\n') : null;
  asides.forEach(aside => aside.remove());

  const rawId = el.getAttribute('data-cm-id');
  return {
    id: rawId && rawId !== '' ? rawId : null,
    html: isContainer ? null : el.innerHTML,
    notes,
    hidden: el.getAttribute('data-hidden') === 'true',
    attrs: cleanSectionAttrs(el),
    children,
  };
}

/**
 * Parse a full document (loader/fetch-latest/savedContent) or the editor's
 * posted `<div class="slides">` wrapper into a canonical snapshot. Returns
 * null when the content cannot be snapshotted (no sections, deep nesting) —
 * the caller then has no ops path and uses the whole-doc save.
 */
export function extractDeckSnapshot(
  html: string,
  parseDocument: DocumentParser
): DeckSnapshot | null {
  let doc: Document;
  try {
    doc = parseDocument(html);
  } catch {
    return null;
  }
  const container = doc.querySelector('.slides') ?? doc.body;
  if (!container) return null;

  const reveal = doc.querySelector('.reveal');
  const theme =
    reveal?.getAttribute('data-theme') ?? container.getAttribute('data-theme') ?? 'white';
  const codeTheme =
    reveal?.getAttribute('data-code-theme') ??
    container.getAttribute('data-code-theme') ??
    'github';

  cleanupContainer(container);

  const rootSections = Array.from(container.querySelectorAll('section')).filter(
    section => !section.parentElement?.closest('section')
  );
  if (rootSections.length === 0) return null;

  const sections: DiffSection[] = [];
  for (const el of rootSections) {
    const section = sectionToDiff(el, true);
    if (!section) return null;
    sections.push(section);
  }
  return { theme, codeTheme, sections };
}

// ─── Pure diff planner + simulator ───────────────────────────────────────────

const ROOT = '__root__';

/** Thrown internally when the plan hits anything inexpressible — mapped to null. */
class DiffBail extends Error {}

interface FlatEntry {
  section: DiffSection;
  parent: string; // ROOT or container id
}

function flatten(sections: DiffSection[], requireIds: boolean): Map<string, FlatEntry> | null {
  const map = new Map<string, FlatEntry>();
  const add = (section: DiffSection, parent: string): boolean => {
    if (section.id == null) {
      if (requireIds) return false; // baseline must be fully id-tagged
      return true; // new sections are not flat entries
    }
    if (map.has(section.id)) return false; // duplicate id — never diffable
    map.set(section.id, { section, parent });
    return true;
  };
  for (const section of sections) {
    if (!add(section, ROOT)) return null;
    for (const child of section.children ?? []) {
      if (child.children != null) return null; // impossible nesting
      if (!add(child, section.id ?? ROOT)) return null;
      if (section.id == null && child.id != null) {
        // A NEW container wrapping EXISTING slides cannot be expressed as an
        // insert (inserts mint fresh child ids) — bail.
        return null;
      }
    }
  }
  return map;
}

const eqRecord = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => b[key] === a[key]);
};

// ── Simulation (mirrors applyDeckOps semantics, minus html normalization) ──

interface SimNode {
  id: string | null; // null = inserted this save (spec carried for compare)
  html: string | null;
  notes: string | null;
  hidden: boolean;
  attrs: Record<string, string>;
  children: SimNode[] | null;
}

function simFromSection(section: DiffSection): SimNode {
  return {
    id: section.id,
    html: section.html,
    notes: section.notes,
    hidden: section.hidden,
    attrs: { ...section.attrs },
    children: section.children ? section.children.map(simFromSection) : null,
  };
}

function simFromSpec(spec: NewSlideSpec): SimNode {
  return {
    id: null,
    html: spec.children ? null : (spec.html ?? ''),
    notes: spec.notes != null && spec.notes !== '' ? spec.notes : null,
    hidden: spec.hidden === true,
    attrs: { ...(spec.attrs ?? {}) },
    children: spec.children ? spec.children.map(simFromSpec) : null,
  };
}

function findSim(
  root: SimNode[],
  id: string
): { parent: SimNode[]; index: number; node: SimNode } | null {
  for (let i = 0; i < root.length; i++) {
    if (root[i].id === id) return { parent: root, index: i, node: root[i] };
    const children = root[i].children;
    if (children) {
      for (let j = 0; j < children.length; j++) {
        if (children[j].id === id) return { parent: children, index: j, node: children[j] };
      }
    }
  }
  return null;
}

function simInsertAt(root: SimNode[], nodes: SimNode[], position: DeckDiffPosition): void {
  if ('after' in position) {
    const target = findSim(root, position.after);
    if (!target) throw new DiffBail(`unknown anchor ${position.after}`);
    if (nodes.some(n => n.children != null) && target.parent !== root) {
      throw new DiffBail('stack cannot land inside a stack');
    }
    target.parent.splice(target.index + 1, 0, ...nodes);
  } else if (position.at === 'start') {
    root.unshift(...nodes);
  } else {
    root.push(...nodes);
  }
}

/** Apply one op to the sim tree; throws DiffBail on anything the engine would refuse. */
function simApply(root: SimNode[], op: DeckDiffOp): void {
  switch (op.op) {
    case 'update': {
      const found = findSim(root, op.id);
      if (!found) throw new DiffBail(`unknown id ${op.id}`);
      if (op.html !== undefined) {
        if (found.node.children?.length) throw new DiffBail('html update on a container');
        found.node.html = op.html;
      }
      if (op.notes !== undefined) found.node.notes = op.notes === '' ? null : op.notes;
      if (op.hidden !== undefined) found.node.hidden = op.hidden;
      if (op.attrs !== undefined) found.node.attrs = { ...(op.attrs ?? {}) };
      break;
    }
    case 'insert':
      simInsertAt(root, op.slides.map(simFromSpec), op.position);
      break;
    case 'move': {
      if ('after' in op.position && op.position.after === op.id) {
        throw new DiffBail('move relative to itself');
      }
      const source = findSim(root, op.id);
      if (!source) throw new DiffBail(`unknown id ${op.id}`);
      const [moved] = source.parent.splice(source.index, 1);
      simInsertAt(root, [moved], op.position);
      break;
    }
    case 'delete': {
      const found = findSim(root, op.id);
      if (!found) throw new DiffBail(`unknown id ${op.id}`);
      if (found.parent === root && root.length === 1) {
        throw new DiffBail('cannot delete the last slide');
      }
      found.parent.splice(found.index, 1);
      break;
    }
    case 'reorder': {
      const ids = root.map(n => n.id);
      if (ids.some(id => id == null)) throw new DiffBail('reorder over unminted inserts');
      const idSet = new Set(ids as string[]);
      const isPermutation =
        op.order.length === ids.length &&
        new Set(op.order).size === op.order.length &&
        op.order.every(id => idSet.has(id));
      if (!isPermutation) throw new DiffBail('reorder is not a permutation');
      const byId = new Map(root.map(n => [n.id as string, n]));
      root.splice(0, root.length, ...op.order.map(id => byId.get(id) as SimNode));
      break;
    }
  }
}

/** Deep equality: simulated final tree vs the current snapshot. */
function simMatches(nodes: SimNode[], sections: DiffSection[]): boolean {
  if (nodes.length !== sections.length) return false;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const section = sections[i];
    if (node.id !== section.id) return false;
    if ((node.children != null) !== (section.children != null)) return false;
    if (node.children && section.children) {
      if (!simMatches(node.children, section.children)) return false;
    } else if (node.html !== section.html) {
      return false;
    }
    if ((node.notes ?? null) !== (section.notes ?? null)) return false;
    if (node.hidden !== section.hidden) return false;
    if (!eqRecord(node.attrs, section.attrs)) return false;
  }
  return true;
}

// ── Planner ──

function planUpdate(base: DiffSection, curr: DiffSection): DeckDiffOp | null {
  const op: DeckDiffOp = { op: 'update', id: curr.id as string };
  let changed = false;
  if (curr.children == null && base.html !== curr.html) {
    const html = curr.html ?? '';
    if (html.length > MAX_HTML) throw new DiffBail('html too large');
    op.html = html;
    changed = true;
  }
  if ((base.notes ?? null) !== (curr.notes ?? null)) {
    const notes = curr.notes ?? '';
    if (notes.length > MAX_NOTES) throw new DiffBail('notes too large');
    op.notes = notes;
    changed = true;
  }
  if (base.hidden !== curr.hidden) {
    op.hidden = curr.hidden;
    changed = true;
  }
  if (!eqRecord(base.attrs, curr.attrs)) {
    op.attrs = Object.keys(curr.attrs).length > 0 ? { ...curr.attrs } : null;
    changed = true;
  }
  return changed ? op : null;
}

function specFromSection(section: DiffSection): NewSlideSpec {
  const spec: NewSlideSpec = {};
  if (section.children) {
    if (section.children.length > MAX_INSERT_GROUP) throw new DiffBail('stack too large');
    spec.children = section.children.map(child => {
      if (child.id != null || child.children != null) {
        throw new DiffBail('new stack may only hold new leaves');
      }
      return specFromSection(child);
    });
  } else {
    const html = section.html ?? '';
    if (html.length > MAX_HTML) throw new DiffBail('html too large');
    spec.html = html;
  }
  if (section.notes != null && section.notes !== '') {
    if (section.notes.length > MAX_NOTES) throw new DiffBail('notes too large');
    spec.notes = section.notes;
  }
  if (section.hidden) spec.hidden = true;
  if (Object.keys(section.attrs).length > 0) spec.attrs = { ...section.attrs };
  return spec;
}

/**
 * Diff two snapshots into an op list the server replays onto the base.
 *
 * Returns:
 *  - `DeckDiffOp[]` (possibly empty — no changes) when the delta is
 *    expressible AND the simulation verifies the replay reproduces `curr`;
 *  - `null` for anything else (theme change, duplicate/unknown ids,
 *    containerness changes, inexpressible positions, planner misses) — the
 *    caller falls back to the whole-document save.
 */
export function diffDeckSnapshots(base: DeckSnapshot, curr: DeckSnapshot): DeckDiffOp[] | null {
  try {
    // Theme/code-theme changes take the whole-doc path: their merge rules
    // (dark-pair clearing, starter-CSS drop) live in buildEditorDeck.
    if (base.theme !== curr.theme || base.codeTheme !== curr.codeTheme) return null;

    const baseFlat = flatten(base.sections, true);
    const currFlat = flatten(curr.sections, false);
    if (!baseFlat || !currFlat) return null;

    // Every current id must exist in base (ids are never minted client-side;
    // an unknown id means a duplicate re-mint or foreign paste — not diffable),
    // and containerness must be stable per id.
    for (const [id, entry] of currFlat) {
      const baseEntry = baseFlat.get(id);
      if (!baseEntry) return null;
      if ((baseEntry.section.children != null) !== (entry.section.children != null)) return null;
    }

    const ops: DeckDiffOp[] = [];
    const sim = base.sections.map(simFromSection);
    const push = (op: DeckDiffOp): void => {
      simApply(sim, op);
      ops.push(op);
    };

    // 1. Content updates (leaves and containers, by id).
    for (const [id, entry] of currFlat) {
      const baseEntry = baseFlat.get(id);
      if (!baseEntry) return null; // unreachable — validated above
      const op = planUpdate(baseEntry.section, entry.section);
      if (op) push(op);
    }

    // Current scope orders (existing ids only) + preceding-existing-id anchors.
    const currScopes = new Map<string, DiffSection[]>();
    currScopes.set(ROOT, curr.sections);
    for (const section of curr.sections) {
      if (section.id != null && section.children != null) {
        currScopes.set(section.id, section.children);
      }
    }

    // 2. Cross-scope moves, in current document order: membership first —
    //    exact ordering is restored by the reorder op (root) / chains (stacks).
    for (const [scopeId, sections] of currScopes) {
      for (const section of sections) {
        if (section.id == null) continue;
        if (baseFlat.get(section.id)?.parent === scopeId) continue;
        // Anchor: nearest preceding sibling with an id (already settled —
        // earlier moves in document order have run).
        let anchor: string | null = null;
        for (const sibling of sections) {
          if (sibling === section) break;
          if (sibling.id != null) anchor = sibling.id;
        }
        if (anchor != null) {
          push({ op: 'move', id: section.id, position: { after: anchor } });
        } else if (scopeId === ROOT) {
          push({ op: 'move', id: section.id, position: { at: 'start' } });
        } else {
          // First position of a stack has no expressible anchor.
          return null;
        }
      }
    }

    // 3. Deletes — top-most deleted nodes only (a deleted container takes its
    //    still-deleted children with it; children that survived moved out in 2).
    for (const section of base.sections) {
      const id = section.id as string;
      if (!currFlat.has(id)) {
        push({ op: 'delete', id });
        continue;
      }
      for (const child of section.children ?? []) {
        const childId = child.id as string;
        if (!currFlat.has(childId)) push({ op: 'delete', id: childId });
      }
    }

    // 4. Top-level reorder (existing ids — inserts are not minted yet).
    const currRootIds = curr.sections
      .filter(section => section.id != null)
      .map(section => section.id as string);
    const simRootIds = sim.map(node => node.id);
    if (JSON.stringify(simRootIds) !== JSON.stringify(currRootIds)) {
      if (currRootIds.length === 0) return null; // total wipe — whole-doc handles
      push({ op: 'reorder', order: currRootIds });
    }

    // 5. Stack child order: a chain of after-anchored moves forces the exact
    //    final sequence (membership settled in 2/3).
    for (const [scopeId, sections] of currScopes) {
      if (scopeId === ROOT) continue;
      const currIds = sections.filter(s => s.id != null).map(s => s.id as string);
      const container = findSim(sim, scopeId);
      if (!container) return null;
      const simIds = (container.node.children ?? []).map(n => n.id);
      if (JSON.stringify(simIds) === JSON.stringify(currIds)) continue;
      for (let i = 1; i < currIds.length; i++) {
        push({ op: 'move', id: currIds[i], position: { after: currIds[i - 1] } });
      }
    }

    // 6. Inserts: consecutive id-less runs, anchored on their preceding
    //    existing sibling (now in its final slot).
    for (const [scopeId, sections] of currScopes) {
      let group: DiffSection[] = [];
      let anchor: string | null = null;
      const flush = (): void => {
        if (group.length === 0) return;
        if (group.length > MAX_INSERT_GROUP) throw new DiffBail('insert group too large');
        const slides = group.map(specFromSection);
        if (anchor != null) {
          push({ op: 'insert', slides, position: { after: anchor } });
        } else if (scopeId === ROOT) {
          push({ op: 'insert', slides, position: { at: 'start' } });
        } else {
          throw new DiffBail('stack-front insert has no anchor');
        }
        group = [];
      };
      for (const section of sections) {
        if (section.id == null) {
          if (scopeId !== ROOT && section.children != null) return null; // nested stack
          group.push(section);
        } else {
          flush();
          anchor = section.id;
        }
      }
      flush();
    }

    if (ops.length > MAX_OPS) return null;

    // 7. The proof: replaying the plan must reproduce the current snapshot
    //    exactly. Any miss → whole-doc fallback.
    if (!simMatches(sim, curr.sections)) return null;

    return ops;
  } catch (error) {
    if (error instanceof DiffBail) return null;
    throw error;
  }
}
