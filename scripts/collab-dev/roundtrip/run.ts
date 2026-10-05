/**
 * Live-editing round-trip harness over REAL content repos (read-only).
 *
 *   node --experimental-strip-types scripts/collab-dev/roundtrip/run.ts \
 *     [--repo owner/name ...] [--dir /path/to/clone ...] [--out /tmp/collab-roundtrip] [--keep]
 *   node --experimental-strip-types scripts/collab-dev/roundtrip/run.ts --self-test
 *
 * Proves (or disproves) that every existing page and deck survives the live
 * editing path byte-identically, using the production converters of this
 * branch. Nothing is written anywhere but `--out` (default
 * /tmp/collab-roundtrip): repos are shallow-cloned there with `gh repo clone`
 * (GET only) and deleted at the end unless `--keep`. With no `--repo`/`--dir`
 * the default repo list below is used.
 *
 * Course content never reaches stdout: the console gets counts and diff TAGS
 * (block types, prop names, short default values). Values and per-file detail
 * go to `<out>/report.md`; the stage outputs of every file that is not
 * identical go to `<out>/out/<repo>/<path>/`.
 *
 * ## Pages (`pages/<slug>/content.json`)
 *
 * Every stage is serialized through the real `preparePageContent` (synthetic
 * page target with no classroom id, so asset canonicalization is a no-op, and
 * an explicit cover, so there is no re-read) and compared with the previous:
 *
 *   S0  the file as stored
 *   S1  seed prep only: what the collab page adapter's `seed` does before the
 *       doc exists — raw blocks (as `loadPageContent` returns them) →
 *       `ensureBlockIds` → `normalizeBlockStructure` → `nonEmpty`
 *   S2  S1 through BlockNote alone, no Yjs (blocks → ProseMirror → blocks, as
 *       the editor would save them; code content flattened first, as
 *       `blocksToYDoc` does)
 *   S3  S1 → `pageContentToYDoc` → Yjs update (as collab_docs stores it) →
 *       fresh doc → `yDocToPageContent` — exactly what the checkpoint worker
 *       renders and commits
 *   S4  S3 seeded and rendered again (idempotence: a pushed file reseeded)
 *
 * Classification of S3 against S0 (the task's three classes):
 *   identical   bytes equal
 *   known       equal once object keys are sorted and code-block content is
 *               flattened (BlockNote 0.55's key order — `id` first, its own
 *               prop order for headings, lists, images…; links / styles in
 *               code blocks) or once whitespace is reformatted
 *   (`--self-test` runs synthetic repros of each class plus controls that
 *   corrupt the Yjs render, and fails if any is misclassified.)
 *   UNEXPECTED  anything else — tagged per stage so the cause is attributable:
 *               S0→S1 seed prep, S1→S2 BlockNote, S2→S3 Yjs, S3→S4 not
 *               idempotent. Only S2→S3 and S3→S4 indict the live path itself;
 *               S0→S1 / S1→S2 are what today's editor would also write on its
 *               next save of the page.
 * Also: the worker's `checkPageRender` guard on the S3 render, and the server
 * `blocksToFullHTML` on S3 (render throws).
 *
 * ## Decks (`slides/<slug>/deck.json`, else legacy `index.html`)
 *
 *   D0  deck.json as stored (or index.html for a legacy deck)
 *   D1  today's save of the loaded deck: `loadDeck` semantics (JSON parse +
 *       `stripDeckRuntimeAttrs`, or `parseDeckHtml`) → `prepareDeckForSave`
 *   D2  loaded deck → `deckToYDoc` → Yjs update → fresh doc → `yDocToDeck` →
 *       `prepareDeckForSave` (what the worker commits: deck.json + index.html)
 *   D3  D2 round-tripped again (idempotence)
 *
 * Gate: D2 === D1 for both files. Against D0: identical / known (runtime
 * attrs stripped, key order, legacy html → deck.json migration) /
 * UNEXPECTED. The regenerated index.html is also compared with the stored
 * one, for information only (title and shared/custom theme URLs come from the
 * database, which this harness does not read).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as Y from 'yjs';

import { FRAGMENT, normalizeCodeBlockContent } from '@classmoji/page-schema';
import {
  getServerEditor,
  pageContentToYDoc,
  yDocToPageContent,
} from '@classmoji/page-schema/server';
import { ClassmojiService } from '@classmoji/services';
import {
  generateDeckHtml,
  parseDeckHtml,
  prepareDeckForSave,
  type DeckJson,
} from '@classmoji/services/slides';
import { stripDeckRuntimeAttrs } from '@classmoji/services/slides/runtime-attrs';
import { deckToYDoc, yDocToDeck } from '@classmoji/collab';
// Relative: the collab server and the worker are apps, not packages.
import { nonEmpty, type PageBlock } from '../../../apps/collab/src/adapters/pageDoc.ts';
import { checkPageRender } from '../../../packages/tasks/src/helpers/checkpointGuards.ts';
import { droppedSlideIds } from '../../../packages/tasks/src/helpers/contentCheckpointCore.ts';

const pageContent = ClassmojiService.pageContent;

// ─── CLI ─────────────────────────────────────────────────────────────────────

// Repos to check by default: the dev classroom's, plus any listed in
// COLLAB_ROUNDTRIP_REPOS (comma-separated `org/repo`). Course repos are
// passed in, never hardcoded.
const DEFAULT_REPOS = [
  'classmoji-development/content-musashibot-testing',
  ...(process.env.COLLAB_ROUNDTRIP_REPOS ?? '')
    .split(',')
    .map(repo => repo.trim())
    .filter(Boolean),
];

function parseArgs(argv: string[]) {
  const repos: string[] = [];
  const dirs: string[] = [];
  let out = '/tmp/collab-roundtrip';
  let keep = false;
  let selfTest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') selfTest = true;
    else if (a === '--repo') repos.push(argv[++i]);
    else if (a === '--dir') dirs.push(argv[++i]);
    else if (a === '--out') out = argv[++i];
    else if (a === '--keep') keep = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (repos.length === 0 && dirs.length === 0 && !selfTest) repos.push(...DEFAULT_REPOS);
  return { repos, dirs, out, keep, selfTest };
}

// ─── Generic helpers ─────────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (isObj(v)) {
    const out: Obj = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

const canon = (v: unknown) => JSON.stringify(sortKeysDeep(v));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A value short and plain enough to print in a tag (defaults, flags, enums). */
function tagValue(v: unknown): string {
  if (typeof v === 'boolean' || typeof v === 'number' || v === null) return String(v);
  if (typeof v === 'string' && v.length <= 24 && /^[\w#.:/ -]*$/.test(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isObj(v)) return '{…}';
  return '…';
}

/** A value for report.md details (truncated). */
function detailValue(v: unknown, max = 80): string {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function writeOut(dir: string, name: string, text: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

// ─── Structural diff (pages) ────────────────────────────────────────────────

interface Diff {
  /** Aggregatable label with no course content, e.g. `prop-added(heading.isToggleable=false)`. */
  tag: string;
  /** Location + values, report.md only. */
  detail: string;
}

interface InlineLike {
  type?: string;
  text?: string;
  styles?: Obj;
  content?: unknown;
  href?: string;
}

function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(inlineText).join('');
  if (!isObj(content)) return '';
  const node = content as InlineLike;
  if (typeof node.text === 'string') return node.text;
  if (node.content !== undefined) return inlineText(node.content);
  return '';
}

function diffBlockList(a: unknown[], b: unknown[], where: string, out: Diff[]) {
  const ids = (list: unknown[]) =>
    list.map(x => (isObj(x) && typeof x.id === 'string' ? x.id : null));
  const aIds = ids(a);
  const bIds = ids(b);
  const allIds = aIds.every(Boolean) && bIds.every(Boolean);
  if (allIds) {
    const bMap = new Map(b.map((x, i) => [bIds[i] as string, x]));
    const aSet = new Set(aIds);
    for (let i = 0; i < a.length; i++) {
      const id = aIds[i] as string;
      const blk = a[i] as Obj;
      if (!bMap.has(id)) {
        out.push({
          tag: `block-dropped(${String(blk.type)})`,
          detail: `${where}: block ${id} (${String(blk.type)}) missing`,
        });
      } else {
        diffBlock(blk, bMap.get(id) as Obj, `${where}/${id}`, out);
      }
    }
    for (let i = 0; i < b.length; i++) {
      if (!aSet.has(bIds[i])) {
        const blk = b[i] as Obj;
        out.push({
          tag: `block-added(${String(blk.type)})`,
          detail: `${where}: block ${bIds[i]} (${String(blk.type)}) added at ${i}`,
        });
      }
    }
    const common = aIds.filter(id => bMap.has(id as string));
    const commonB = bIds.filter(id => aSet.has(id));
    if (common.join() !== commonB.join()) {
      out.push({ tag: 'block-reordered', detail: `${where}: order of kept blocks changed` });
    }
    return;
  }
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as Obj | undefined;
    const y = b[i] as Obj | undefined;
    if (!x) {
      out.push({
        tag: `block-added(${String(y?.type)})`,
        detail: `${where}[${i}]: added ${String(y?.type)}`,
      });
    } else if (!y) {
      out.push({
        tag: `block-dropped(${String(x.type)})`,
        detail: `${where}[${i}]: dropped ${String(x.type)}`,
      });
    } else {
      diffBlock(x, y, `${where}[${i}]`, out);
    }
  }
}

function diffBlock(a: Obj, b: Obj, where: string, out: Diff[]) {
  const type = String(a.type);
  if (a.id !== b.id) {
    if (a.id == null) {
      out.push({ tag: `id-filled(${type})`, detail: `${where}: id → ${String(b.id)}` });
    } else if (b.id == null) {
      out.push({ tag: `id-dropped(${type})`, detail: `${where}: id ${String(a.id)} dropped` });
    } else {
      out.push({
        tag: `id-changed(${type})`,
        detail: `${where}: id ${String(a.id)} → ${String(b.id)}`,
      });
    }
  }
  if (a.type !== b.type) {
    out.push({ tag: `type-changed(${type}→${String(b.type)})`, detail: `${where}` });
  }
  // props
  const ap = isObj(a.props) ? a.props : {};
  const bp = isObj(b.props) ? b.props : {};
  if (a.props !== undefined && b.props === undefined) {
    out.push({ tag: `props-dropped(${type})`, detail: where });
  }
  for (const k of Object.keys(ap)) {
    if (!(k in bp)) {
      out.push({
        tag: `prop-dropped(${type}.${k})`,
        detail: `${where}: props.${k} was ${detailValue(ap[k])}`,
      });
    } else if (canon(ap[k]) !== canon(bp[k])) {
      out.push({
        tag: `prop-changed(${type}.${k}: ${tagValue(ap[k])}→${tagValue(bp[k])})`,
        detail: `${where}: props.${k} ${detailValue(ap[k])} → ${detailValue(bp[k])}`,
      });
    }
  }
  for (const k of Object.keys(bp)) {
    if (!(k in ap)) {
      out.push({
        tag: `prop-added(${type}.${k}=${tagValue(bp[k])})`,
        detail: `${where}: props.${k} = ${detailValue(bp[k])}`,
      });
    }
  }
  // content
  if (canon(a.content) !== canon(b.content)) {
    const ac = a.content;
    const bc = b.content;
    if (Array.isArray(ac) !== Array.isArray(bc) || (ac === undefined) !== (bc === undefined)) {
      out.push({
        tag: `content-shape-changed(${type}: ${shape(ac)}→${shape(bc)})`,
        detail: `${where}: content ${detailValue(ac, 60)} → ${detailValue(bc, 60)}`,
      });
    } else if (isObj(ac) && ac.type === 'tableContent') {
      out.push({
        tag: `table-content-changed(${tableDiffKind(ac, bc as Obj)})`,
        detail: `${where}: table ${detailValue(ac, 200)} → ${detailValue(bc, 200)}`,
      });
    } else if (inlineText(ac) !== inlineText(bc)) {
      out.push({
        tag: `text-changed(${type})`,
        detail: `${where}: text ${detailValue(inlineText(ac), 120)} → ${detailValue(inlineText(bc), 120)}`,
      });
    } else {
      out.push({
        tag: `inline-structure-changed(${type}: ${inlineKind(ac, bc)})`,
        detail: `${where}: ${detailValue(ac, 200)} → ${detailValue(bc, 200)}`,
      });
    }
  }
  // other block keys
  const known = new Set(['id', 'type', 'props', 'content', 'children']);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (known.has(k)) continue;
    if (!(k in b)) out.push({ tag: `block-key-dropped(${type}.${k})`, detail: where });
    else if (!(k in a)) out.push({ tag: `block-key-added(${type}.${k})`, detail: where });
    else if (canon(a[k]) !== canon(b[k]))
      out.push({ tag: `block-key-changed(${type}.${k})`, detail: where });
  }
  // children
  const ach = Array.isArray(a.children) ? a.children : undefined;
  const bch = Array.isArray(b.children) ? b.children : undefined;
  if ((ach === undefined) !== (bch === undefined)) {
    out.push({
      tag: `children-shape-changed(${type}: ${shape(a.children)}→${shape(b.children)})`,
      detail: where,
    });
  }
  diffBlockList(ach ?? [], bch ?? [], `${where}>`, out);
}

function shape(v: unknown): string {
  if (v === undefined) return 'absent';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? 'array' : '[]';
  if (isObj(v)) return `object${typeof v.type === 'string' ? `:${v.type}` : ''}`;
  return typeof v;
}

function inlineKind(a: unknown, b: unknown): string {
  const flat = (v: unknown): InlineLike[] => (Array.isArray(v) ? (v as InlineLike[]) : []);
  const fa = flat(a);
  const fb = flat(b);
  if (fa.length !== fb.length) return `runs ${fa.length}→${fb.length}`;
  for (let i = 0; i < fa.length; i++) {
    const x = fa[i];
    const y = fb[i];
    if (x?.type !== y?.type) return `run-type ${String(x?.type)}→${String(y?.type)}`;
    if (canon(x?.styles) !== canon(y?.styles)) return `styles`;
    if (x?.href !== y?.href) return `href`;
    if (canon(x) !== canon(y)) {
      const keys = [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])]
        .filter(k => canon((x as Obj)?.[k]) !== canon((y as Obj)?.[k]))
        .join(',');
      return `run-keys ${keys}`;
    }
  }
  return 'other';
}

function tableDiffKind(a: Obj, b: Obj): string {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(
    k => canon(a?.[k]) !== canon(b?.[k])
  );
  if (keys.length === 1 && keys[0] === 'rows') {
    const ar = (a.rows as Obj[]) ?? [];
    const br = (b.rows as Obj[]) ?? [];
    if (ar.length !== br.length) return `rows ${ar.length}→${br.length}`;
    for (let i = 0; i < ar.length; i++) {
      const ac = (ar[i]?.cells as unknown[]) ?? [];
      const bc = (br[i]?.cells as unknown[]) ?? [];
      if (ac.length !== bc.length) return `cells ${ac.length}→${bc.length}`;
      for (let j = 0; j < ac.length; j++) {
        const x = ac[j];
        const y = bc[j];
        if (canon(x) === canon(y)) continue;
        if (inlineText(cellContent(x)) !== inlineText(cellContent(y))) return 'cell-text';
        if (Array.isArray(x) && isObj(y)) return 'cell array→tableCell';
        if (isObj(x) && isObj(y)) {
          const ck = [...new Set([...Object.keys(x), ...Object.keys(y)])]
            .filter(k => canon(x[k]) !== canon(y[k]))
            .join(',');
          return `cell-keys ${ck}`;
        }
        return 'cell-other';
      }
    }
  }
  return `keys ${keys.join(',')}`;
}

function cellContent(cell: unknown): unknown {
  return isObj(cell) && 'content' in cell ? cell.content : cell;
}

/** Diffs between two content.json wrapper values. */
function diffPageWrappers(a: Obj, b: Obj): Diff[] {
  const out: Diff[] = [];
  if (canon(a.coverImage ?? null) !== canon(b.coverImage ?? null)) {
    out.push({
      tag: 'cover-changed',
      detail: `cover ${detailValue(a.coverImage)} → ${detailValue(b.coverImage)}`,
    });
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'blocks' || k === 'coverImage') continue;
    out.push({ tag: `wrapper-key(${k})`, detail: `wrapper key ${k}` });
  }
  diffBlockList(
    Array.isArray(a.blocks) ? a.blocks : [],
    Array.isArray(b.blocks) ? b.blocks : [],
    'blocks',
    out
  );
  return out;
}

/** Why two byte strings that parse to the same tree differ. */
function formattingTag(a: string, b: string): string {
  try {
    const pa = JSON.parse(a);
    const pb = JSON.parse(b);
    if (JSON.stringify(pa) === JSON.stringify(pb)) {
      if (a.trimEnd() === b.trimEnd()) return 'formatting(trailing-whitespace)';
      return 'formatting(indent/escapes)';
    }
    if (canon(pa) === canon(pb)) return 'key-order';
  } catch {
    /* not JSON */
  }
  return '';
}

/** Where two equal-modulo-key-order trees differ in key order, as `key-order(<where>)`. */
function keyOrderDiffs(a: unknown, b: unknown, where: string, out: Map<string, string>) {
  if (Array.isArray(a) && Array.isArray(b)) {
    a.forEach((x, i) => {
      const type = isObj(x) && typeof x.type === 'string' ? x.type : null;
      keyOrderDiffs(x, b[i], type ? `${type}` : where, out);
    });
    return;
  }
  if (!isObj(a) || !isObj(b)) return;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.join() !== kb.join()) {
    out.set(`key-order(${where})`, `${where}: [${ka.join(',')}] → [${kb.join(',')}]`);
  }
  for (const k of ka) {
    const child = a[k];
    const label =
      k === 'props' || k === 'styles'
        ? `${where}.${k}`
        : k === 'content' || k === 'children'
          ? where
          : `${where}.${k}`;
    keyOrderDiffs(child, b[k], label, out);
  }
}

/** Stage-to-stage diff tags of two content.json byte strings. */
function stagePageDiff(a: string, b: string): Diff[] {
  if (a === b) return [];
  const f = formattingTag(a, b);
  if (f === 'key-order') {
    const m = new Map<string, string>();
    keyOrderDiffs(JSON.parse(a), JSON.parse(b), 'wrapper', m);
    return [...m].map(([tag, detail]) => ({ tag, detail }));
  }
  if (f) return [{ tag: f, detail: f }];
  let pa: unknown = JSON.parse(a);
  const pb = JSON.parse(b) as Obj;
  const out: Diff[] = [];
  if (Array.isArray(pa)) {
    out.push({ tag: 'legacy-bare-array→wrapper', detail: 'bare block array rewritten as wrapper' });
    pa = { blocks: pa };
  }
  out.push(...diffPageWrappers(pa as Obj, pb));
  if (out.length === 0) out.push({ tag: 'key-order', detail: 'key order only' });
  return out;
}

// ─── Pages ───────────────────────────────────────────────────────────────────

type PageClass =
  | 'identical'
  | 'known'
  | 'unexpected'
  | 'legacy-html'
  | 'seed-throw'
  | 'parse-throw';

interface PageResult {
  repo: string;
  path: string;
  cls: PageClass;
  knownTags: string[];
  /** Tags per stage transition (only non-empty ones). */
  stages: Record<string, Diff[]>;
  /** True when the live path itself (S2→S3, S3→S4, guard, render) is implicated. */
  collabInduced: boolean;
  guard?: string;
  renderThrow?: string;
  renderThrowPre?: string;
  error?: string;
}

const editor = getServerEditor();

function syntheticPage(contentPath: string) {
  // No classroom id: canonicalization has no context and is a no-op (no DB).
  return {
    id: 'roundtrip',
    title: 'roundtrip',
    content_path: contentPath,
    classroom: {
      git_organization: { login: 'roundtrip', provider: 'GITHUB' },
      content_repo: 'roundtrip',
    },
  };
}

async function preparePage(
  contentPath: string,
  blocks: unknown[],
  coverImage: unknown
): Promise<string> {
  const prepared = await pageContent.preparePageContent(
    syntheticPage(contentPath) as never,
    blocks,
    {
      coverImage: (coverImage ?? null) as never,
    }
  );
  return prepared.content;
}

/** `loadPageContent`'s JSON branch: raw blocks + cover, nothing normalized. */
function loadLikeLoadPageContent(text: string): { blocks: unknown[]; coverImage: unknown } {
  const parsed = JSON.parse(text) as unknown;
  if (isObj(parsed) && Array.isArray(parsed.blocks)) {
    return { blocks: parsed.blocks, coverImage: parsed.coverImage || null };
  }
  return { blocks: parsed as unknown[], coverImage: null };
}

/** The collab page adapter's seed prep (apps/collab/src/adapters/page.ts `seed`). */
function seedPrep(blocks: unknown[]): PageBlock[] {
  return nonEmpty(
    pageContent.normalizeBlockStructure(pageContent.ensureBlockIds(blocks)) as PageBlock[]
  );
}

/** Seed → encode (as collab_docs stores it) → fresh doc → render. */
function yjsTrip(blocks: unknown[], coverImage: unknown) {
  const seeded = pageContentToYDoc({ blocks, coverImage: coverImage as never });
  const stored = Y.encodeStateAsUpdate(seeded);
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, stored);
  const content = yDocToPageContent(loaded);
  return { loaded, content };
}

function blockNoteOnly(blocks: unknown[]): unknown[] {
  const ed = editor as unknown as {
    _blocksToProsemirrorNode(b: unknown): unknown;
    _prosemirrorNodeToBlocks(n: unknown): unknown[];
  };
  return ed._prosemirrorNodeToBlocks(
    ed._blocksToProsemirrorNode(normalizeCodeBlockContent(blocks))
  );
}

/**
 * `blocksToFullHTML` the way the production page renderer calls it
 * (apps/pages/app/site/render.server.ts): inside the editor's JSDOM scope,
 * with a working localStorage (BlockNote's toggle wrapper reads it, and the
 * bare JSDOM's opaque origin throws on it), then React's deferred work
 * drained before the scope closes.
 */
async function renderFullHtml(blocks: unknown[]): Promise<string> {
  const ed = editor as unknown as {
    _withJSDOM<T>(fn: () => Promise<T>): Promise<T>;
    blocksToFullHTML(b: unknown): Promise<string>;
  };
  return ed._withJSDOM(async () => {
    const win = globalThis.window as unknown as Record<string, unknown> | undefined;
    if (win && !win.__roundtripStorage) {
      const store = new Map<string, string>();
      const storage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(String(k), String(v)),
        removeItem: (k: string) => void store.delete(String(k)),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size;
        },
      };
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(win, name, { value: storage, configurable: true, writable: true });
      }
      win.__roundtripStorage = true;
    }
    const html = await ed.blocksToFullHTML(blocks);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setImmediate(resolve));
    return html;
  });
}

/** Known normalizations only: equal once keys are sorted and code content is flattened. */
function knownEquivalent(original: string, out: string): string[] | null {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(original);
    b = JSON.parse(out);
  } catch {
    return null;
  }
  if (Array.isArray(a)) return null; // the bare-array → wrapper rewrite is not a listed one
  const flatA = { ...(a as Obj), blocks: normalizeCodeBlockContent((a as Obj).blocks) };
  const flatB = { ...(b as Obj), blocks: normalizeCodeBlockContent((b as Obj).blocks) };
  if (canon(flatA) !== canon(flatB)) return null;
  const tags: string[] = [];
  if (canon(a) !== canon(b)) tags.push('code-flatten');
  const sortedFlatA = JSON.stringify(flatA);
  const sortedFlatB = JSON.stringify(flatB);
  if (sortedFlatA !== sortedFlatB) tags.push('key-order');
  if (tags.length === 0) tags.push(formattingTag(original, out) || 'formatting');
  return tags;
}

/** Self-test only: corrupt the Yjs render, to prove a collab-induced change is caught. */
type PageFault = (blocks: unknown[]) => unknown[];

async function runPage(
  repo: string,
  root: string,
  rel: string,
  outDir: string,
  fault?: PageFault
): Promise<PageResult> {
  const contentPath = rel.replace(/\/content\.json$/, '');
  const s0 = readFileSync(join(root, rel), 'utf8');
  const res: PageResult = {
    repo,
    path: rel,
    cls: 'identical',
    knownTags: [],
    stages: {},
    collabInduced: false,
  };

  let loaded: { blocks: unknown[]; coverImage: unknown };
  try {
    loaded = loadLikeLoadPageContent(s0);
  } catch (err) {
    // loadPageContent falls through to index.html; the seed would then refuse.
    return { ...res, cls: 'parse-throw', error: errMsg(err) };
  }

  const prepped = seedPrep(loaded.blocks);
  const s1 = await preparePage(contentPath, prepped, loaded.coverImage);

  let s2: string;
  let s2Blocks: unknown[] = [];
  try {
    s2Blocks = blockNoteOnly(prepped);
    s2 = await preparePage(contentPath, s2Blocks, loaded.coverImage);
  } catch (err) {
    s2 = `<<BlockNote-only threw: ${errMsg(err)}>>`;
  }

  let trip;
  try {
    trip = yjsTrip(prepped, loaded.coverImage);
    if (fault) trip.content = { ...trip.content, blocks: fault(trip.content.blocks) };
  } catch (err) {
    // The adapter turns this into a 422 invalid-block: the page never opens live.
    res.cls = 'seed-throw';
    res.collabInduced = true;
    res.error = errMsg(err);
    return res;
  }
  const s3 = await preparePage(contentPath, trip.content.blocks, trip.content.coverImage);

  const guard = checkPageRender(trip.loaded, FRAGMENT, trip.content.blocks);
  if (!guard.ok) {
    res.guard = guard.reason;
    res.collabInduced = true;
  }
  if (trip.content.blocks.length === 0) {
    res.guard = `${res.guard ? `${res.guard}; ` : ''}empty render`;
    res.collabInduced = true;
  }

  // S4: the pushed file seeded again.
  let s4: string;
  try {
    const again = loadLikeLoadPageContent(s3);
    const t2 = yjsTrip(seedPrep(again.blocks), again.coverImage);
    s4 = await preparePage(contentPath, t2.content.blocks, t2.content.coverImage);
  } catch (err) {
    s4 = `<<second trip threw: ${errMsg(err)}>>`;
  }

  try {
    await renderFullHtml(trip.content.blocks);
  } catch (err) {
    res.renderThrow = errMsg(err);
    try {
      await renderFullHtml(s2Blocks);
    } catch (err2) {
      res.renderThrowPre = errMsg(err2);
    }
    if (!res.renderThrowPre) res.collabInduced = true;
  }

  const stage = (name: string, a: string, b: string) => {
    if (a === b) return;
    if (a.startsWith('<<') || b.startsWith('<<')) {
      res.stages[name] = [{ tag: 'stage-threw', detail: a.startsWith('<<') ? a : b }];
      return;
    }
    res.stages[name] = stagePageDiff(a, b);
  };
  stage('S0→S1 seed prep', s0, s1);
  stage('S1→S2 BlockNote', s1, s2);
  stage('S2→S3 Yjs', s2.startsWith('<<') ? s1 : s2, s3);
  stage('S3→S4 idempotence', s3, s4);
  if (res.stages['S2→S3 Yjs'] || res.stages['S3→S4 idempotence']) res.collabInduced = true;

  if (s3 === s0) {
    res.cls = 'identical';
  } else {
    const known = knownEquivalent(s0, s3);
    if (known) {
      res.cls = 'known';
      res.knownTags = known;
    } else {
      res.cls = 'unexpected';
    }
  }

  if (res.cls !== 'identical' || res.collabInduced || res.guard || res.renderThrow) {
    const dir = join(outDir, 'out', repo, contentPath);
    writeOut(dir, 'S0.original.json', s0);
    writeOut(dir, 'S1.seedprep.json', s1);
    writeOut(dir, 'S2.blocknote.json', s2);
    writeOut(dir, 'S3.collab.json', s3);
    writeOut(dir, 'S4.again.json', s4);
  }
  return res;
}

// ─── Decks ───────────────────────────────────────────────────────────────────

type DeckClass = 'identical' | 'known' | 'unexpected' | 'seed-throw';

interface DeckResult {
  repo: string;
  path: string;
  legacy: boolean;
  cls: DeckClass;
  knownTags: string[];
  /** D2 vs D1 (the gate), D2 vs D3 (idempotence), D1 vs D0. */
  stages: Record<string, Diff[]>;
  collabInduced: boolean;
  guard?: string;
  /** Legacy decks: distinct `parseDeckHtml` warnings (today's load gives the same). */
  parseWarnings?: string[];
  /** Regenerated index.html (D1) vs stored: 'same' | 'differs' | 'n/a (...)'. */
  htmlVsStored: string;
  error?: string;
}

function syntheticSlide(contentPath: string, title: string) {
  return {
    id: 'roundtrip',
    kind: 'DECK',
    title,
    content_path: contentPath,
    classroom: {
      git_organization: { login: 'roundtrip', provider: 'GITHUB' },
      content_repo: 'roundtrip',
    },
  };
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The DB-resolved half of `generateDeckHtml`'s input, read back from the
 * stored index.html: a `shared:` theme's lib CSS + custom-theme.css + body
 * classes, or a `custom:` theme's CSS URL. Builtin themes need none.
 */
function themeUrlsFromStoredHtml(html: string) {
  const head = html.slice(0, html.indexOf('</head>') + 1 || 4000);
  const hrefs = [...head.matchAll(/<link rel="stylesheet" href="([^"]*)"/g)]
    .map(m => unescapeHtml(m[1]))
    .filter(h => !h.startsWith('https://cdn.jsdelivr.net/'));
  const body = html.match(/<body class="([^"]*)">/);
  const bodyClasses = body ? unescapeHtml(body[1]) : undefined;
  if (hrefs.length === 0 && !bodyClasses) return undefined;
  const custom = hrefs.find(h => h.endsWith('/custom-theme.css'));
  const lib = hrefs.find(h => h !== custom);
  return {
    libCssUrl: lib ?? null,
    customThemeUrl: custom ?? null,
    themeUrl: lib ?? null,
    ...(bodyClasses ? { bodyClasses } : {}),
  };
}

function deckYTrip(deck: DeckJson): { doc: Y.Doc; deck: DeckJson } {
  const seeded = deckToYDoc(deck);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded));
  return { doc, deck: yDocToDeck(doc) };
}

type SlideLike = {
  id?: string;
  html?: string;
  notes?: string;
  hidden?: boolean;
  attrs?: Record<string, string>;
  children?: SlideLike[];
  [k: string]: unknown;
};

function diffSlides(a: SlideLike[], b: SlideLike[], where: string, out: Diff[]) {
  const bMap = new Map(b.map(s => [s.id, s]));
  const aIds = a.map(s => s.id);
  const aSet = new Set(aIds);
  for (const s of a) {
    const t = bMap.get(s.id);
    if (!t) {
      out.push({ tag: 'slide-dropped', detail: `${where}: slide ${s.id} missing` });
      continue;
    }
    const w = `${where}/${s.id}`;
    for (const k of new Set([...Object.keys(s), ...Object.keys(t)])) {
      if (k === 'id' || k === 'children' || k === 'attrs') continue;
      if (!(k in t)) out.push({ tag: `slide-field-dropped(${k})`, detail: w });
      else if (!(k in s)) out.push({ tag: `slide-field-added(${k}=${tagValue(t[k])})`, detail: w });
      else if (canon(s[k]) !== canon(t[k])) {
        out.push({
          tag: `slide-${k}-changed`,
          detail: `${w}: ${k} ${detailValue(s[k], 120)} → ${detailValue(t[k], 120)}`,
        });
      }
    }
    const aa = s.attrs ?? {};
    const ba = t.attrs ?? {};
    for (const k of new Set([...Object.keys(aa), ...Object.keys(ba)])) {
      if (!(k in ba))
        out.push({ tag: `attr-dropped(${k})`, detail: `${w}: ${detailValue(aa[k])}` });
      else if (!(k in aa))
        out.push({ tag: `attr-added(${k})`, detail: `${w}: ${detailValue(ba[k])}` });
      else if (aa[k] !== ba[k])
        out.push({
          tag: `attr-changed(${k})`,
          detail: `${w}: ${detailValue(aa[k])} → ${detailValue(ba[k])}`,
        });
    }
    if (Object.keys(aa).join() !== Object.keys(ba).join() && canon(aa) === canon(ba)) {
      out.push({ tag: 'attr-order', detail: w });
    }
    if (s.children || t.children) diffSlides(s.children ?? [], t.children ?? [], w, out);
  }
  for (const t of b) {
    if (!aSet.has(t.id)) out.push({ tag: 'slide-added', detail: `${where}: slide ${t.id} added` });
  }
  const kept = aIds.filter(id => bMap.has(id));
  const keptB = b.map(s => s.id).filter(id => aSet.has(id));
  if (kept.join() !== keptB.join()) out.push({ tag: 'slide-reordered', detail: where });
}

function stageDeckJsonDiff(a: string, b: string): Diff[] {
  if (a === b) return [];
  const f = formattingTag(a, b);
  if (f) return [{ tag: f, detail: f }];
  const pa = JSON.parse(a) as Obj;
  const pb = JSON.parse(b) as Obj;
  const out: Diff[] = [];
  for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (k === 'slides') continue;
    if (!(k in pb)) out.push({ tag: `deck-field-dropped(${k})`, detail: k });
    else if (!(k in pa)) out.push({ tag: `deck-field-added(${k}=${tagValue(pb[k])})`, detail: k });
    else if (canon(pa[k]) !== canon(pb[k])) {
      out.push({
        tag: `deck-${k}-changed`,
        detail: `${k}: ${detailValue(pa[k], 120)} → ${detailValue(pb[k], 120)}`,
      });
    }
  }
  if (Object.keys(pa).join() !== Object.keys(pb).join() && out.length === 0) {
    out.push({ tag: 'deck-key-order', detail: 'top-level key order' });
  }
  diffSlides((pa.slides as SlideLike[]) ?? [], (pb.slides as SlideLike[]) ?? [], 'slides', out);
  if (out.length === 0) out.push({ tag: 'key-order', detail: 'nested key order only' });
  return out;
}

function htmlDiffTag(a: string, b: string): Diff[] {
  if (a === b) return [];
  const al = a.split('\n');
  const bl = b.split('\n');
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  return [
    {
      tag: 'index.html-differs',
      detail: `first differing line ${i + 1}: ${detailValue(al[i], 160)} → ${detailValue(bl[i], 160)}`,
    },
  ];
}

/** Self-test only: corrupt the Yjs render of a deck. */
type DeckFault = (deck: DeckJson) => DeckJson;

async function runDeck(
  repo: string,
  root: string,
  dirRel: string,
  outDir: string,
  fault?: DeckFault
): Promise<DeckResult | null> {
  const deckPath = join(root, dirRel, 'deck.json');
  const htmlPath = join(root, dirRel, 'index.html');
  const hasDeck = existsSync(deckPath);
  const hasHtml = existsSync(htmlPath);
  if (!hasDeck && !hasHtml) return null; // a FILE / LINK slide
  const storedHtml = hasHtml ? readFileSync(htmlPath, 'utf8') : null;
  const titleMatch = storedHtml?.match(/<title>([\s\S]*?)<\/title>/);
  const title = titleMatch ? unescapeHtml(titleMatch[1]) : basename(dirRel);
  const res: DeckResult = {
    repo,
    path: hasDeck ? `${dirRel}/deck.json` : `${dirRel}/index.html`,
    legacy: !hasDeck,
    cls: 'identical',
    knownTags: [],
    stages: {},
    collabInduced: false,
    htmlVsStored: 'n/a',
  };
  const slide = syntheticSlide(dirRel, title);
  const themeUrls = storedHtml ? themeUrlsFromStoredHtml(storedHtml) : undefined;
  const prepare = (deck: DeckJson) =>
    prepareDeckForSave(slide as never, deck, themeUrls ? { themeUrls } : {});

  // loadDeck semantics.
  let d0: string;
  let loaded: DeckJson;
  try {
    if (hasDeck) {
      d0 = readFileSync(deckPath, 'utf8');
      const parsed = JSON.parse(d0) as DeckJson;
      if (parsed?.version !== 1 || !Array.isArray(parsed.slides)) {
        throw new Error('deck.json has an unsupported shape');
      }
      loaded = stripDeckRuntimeAttrs(parsed);
    } else {
      d0 = storedHtml as string;
      const parsed = parseDeckHtml(d0);
      loaded = parsed.deck;
      if (parsed.warnings?.length) {
        res.parseWarnings = [...new Set(parsed.warnings.map(w => String(w).slice(0, 120)))];
      }
    }
  } catch (err) {
    return { ...res, cls: 'seed-throw', error: `load: ${errMsg(err)}` };
  }

  const d1 = await prepare(loaded);

  let trip: { doc: Y.Doc; deck: DeckJson };
  try {
    trip = deckYTrip(loaded);
    if (fault) trip = { ...trip, deck: fault(trip.deck) };
  } catch (err) {
    return { ...res, cls: 'seed-throw', collabInduced: true, error: `deckToYDoc: ${errMsg(err)}` };
  }
  const dropped = droppedSlideIds(trip.doc, trip.deck as never);
  if (dropped.length) {
    res.guard = `dropped ${dropped.length} slide(s)`;
    res.collabInduced = true;
  }
  if (trip.deck.slides.length === 0) {
    res.guard = `${res.guard ? `${res.guard}; ` : ''}empty render`;
    res.collabInduced = true;
  }
  const d2 = await prepare(trip.deck);
  let d3: { deckJson: string; html: string };
  try {
    d3 = await prepare(deckYTrip(d2.deck).deck);
  } catch (err) {
    d3 = { deckJson: `<<${errMsg(err)}>>`, html: '' };
  }

  const gateJson = stageDeckJsonDiff(d1.deckJson, d2.deckJson);
  const gateHtml = htmlDiffTag(d1.html, d2.html);
  if (gateJson.length || gateHtml.length) {
    res.stages['D1→D2 Yjs'] = [...gateJson, ...gateHtml];
    res.collabInduced = true;
  }
  const idem = d3.deckJson.startsWith('<<')
    ? [{ tag: 'stage-threw', detail: d3.deckJson }]
    : [...stageDeckJsonDiff(d2.deckJson, d3.deckJson), ...htmlDiffTag(d2.html, d3.html)];
  if (idem.length) {
    res.stages['D2→D3 idempotence'] = idem;
    res.collabInduced = true;
  }

  if (hasDeck) {
    const pre = stageDeckJsonDiff(d0, d1.deckJson);
    if (pre.length) res.stages['D0→D1 load+prepare'] = pre;
    if (d2.deckJson === d0) {
      res.cls = 'identical';
    } else if (!res.collabInduced) {
      // D2 == D1: only what loading + today's save already do.
      const tags = new Set<string>();
      const stripped = JSON.stringify(stripDeckRuntimeAttrs(JSON.parse(d0)), null, 2) + '\n';
      if (stripped !== d0) tags.add('runtime-attrs-stripped');
      for (const d of stageDeckJsonDiff(stripped, d2.deckJson)) tags.add(d.tag);
      const unknown = [...tags].filter(
        t => !['runtime-attrs-stripped', 'key-order', 'deck-key-order', 'attr-order'].includes(t)
      );
      res.knownTags = [...tags];
      res.cls = unknown.length ? 'unexpected' : 'known';
    } else {
      res.cls = 'unexpected';
    }
  } else {
    res.cls = res.collabInduced ? 'unexpected' : 'known';
    res.knownTags = ['legacy-html-migration'];
  }

  // Informational: today's regenerated index.html vs the stored one (shared /
  // custom theme URLs and body classes taken from the stored file).
  if (storedHtml == null) res.htmlVsStored = 'n/a (no index.html)';
  else if (res.legacy) res.htmlVsStored = d1.html === storedHtml ? 'same' : 'differs (legacy)';
  else res.htmlVsStored = d1.html === storedHtml ? 'same' : 'differs';

  if (res.cls !== 'identical' || res.collabInduced || res.htmlVsStored.startsWith('differs')) {
    const dir = join(outDir, 'out', repo, dirRel);
    writeOut(dir, hasDeck ? 'D0.deck.json' : 'D0.index.html', d0);
    if (storedHtml != null && hasDeck) writeOut(dir, 'D0.index.html', storedHtml);
    writeOut(dir, 'D1.today.deck.json', d1.deckJson);
    writeOut(dir, 'D1.today.index.html', d1.html);
    writeOut(dir, 'D2.collab.deck.json', d2.deckJson);
    writeOut(dir, 'D2.collab.index.html', d2.html);
    writeOut(dir, 'D3.again.deck.json', d3.deckJson);
  }
  // Keep the `generateDeckHtml` import honest (prepare uses it internally).
  void generateDeckHtml;
  return res;
}

// ─── Self-test: synthetic repros + detector controls ─────────────────────────

// BlockNote 0.55's own prop order for default blocks.
const P = { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' };
const run = (text: string, styles: Obj = {}) => ({ type: 'text', text, styles });
const para = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  props: { ...P },
  content: text ? [run(text)] : [],
  children: [],
});
const trailing = para('zz', '');

/**
 * Each case is a synthetic content.json (no course content) with the class
 * the harness must give it and a tag the responsible stage must report.
 */
const SELF_TEST_CASES: Array<{
  name: string;
  file: unknown;
  raw?: string;
  cls: PageClass;
  stage?: string;
  tag?: string;
  fault?: PageFault;
  collabInduced?: boolean;
}> = [
  {
    name: 'blocknote-canonical',
    file: { blocks: [para('a', 'Hello'), trailing] },
    cls: 'identical',
  },
  {
    name: 'known-heading-key-order',
    file: {
      blocks: [
        {
          id: 'h',
          type: 'heading',
          props: { level: 2, isToggleable: false, ...P },
          content: [run('Title')],
          children: [],
        },
        trailing,
      ],
    },
    cls: 'known',
    stage: 'S1→S2 BlockNote',
    tag: 'key-order(heading.props)',
  },
  {
    name: 'known-code-flatten',
    file: {
      blocks: [
        {
          id: 'c',
          type: 'codeBlock',
          props: { language: 'javascript' },
          content: [
            run('const a = 1;', { bold: true }),
            { type: 'link', href: 'https://example.com', content: [run(' // link')] },
          ],
          children: [],
        },
        trailing,
      ],
    },
    cls: 'known',
  },
  {
    name: 'unexpected-default-props-missing',
    file: { blocks: [{ id: 'a', type: 'paragraph', content: [run('Hello')] }, trailing] },
    cls: 'unexpected',
    stage: 'S1→S2 BlockNote',
    tag: 'prop-added(paragraph.textColor="default")',
  },
  {
    name: 'unexpected-heading-no-isToggleable',
    file: {
      blocks: [
        { id: 'h', type: 'heading', props: { ...P, level: 2 }, content: [run('T')], children: [] },
        trailing,
      ],
    },
    cls: 'unexpected',
    stage: 'S1→S2 BlockNote',
    tag: 'prop-added(heading.isToggleable=false)',
  },
  {
    name: 'unexpected-callout-colors',
    file: {
      blocks: [
        {
          id: 'c',
          type: 'callout',
          props: { textAlignment: 'left', emoji: '💡', textColor: 'blue', backgroundColor: 'blue' },
          content: [run('Note')],
          children: [],
        },
        trailing,
      ],
    },
    cls: 'unexpected',
    stage: 'S1→S2 BlockNote',
    tag: 'prop-dropped(callout.backgroundColor)',
  },
  {
    name: 'unexpected-adjacent-plain-runs',
    file: {
      blocks: [
        {
          id: 'a',
          type: 'paragraph',
          props: { ...P },
          content: [run('one '), run('two'), run('')],
          children: [],
        },
        trailing,
      ],
    },
    cls: 'unexpected',
    stage: 'S1→S2 BlockNote',
    tag: 'inline-structure-changed(paragraph: runs 3→1)',
  },
  {
    name: 'unexpected-legacy-table-cells',
    file: {
      blocks: [
        {
          id: 't',
          type: 'table',
          props: { textColor: 'default' },
          content: {
            type: 'tableContent',
            columnWidths: [null, null],
            rows: [{ cells: [[run('a')], [run('b')]] }],
          },
          children: [],
        },
        trailing,
      ],
    },
    cls: 'unexpected',
    stage: 'S1→S2 BlockNote',
    tag: 'table-content-changed(cell array→tableCell)',
  },
  {
    name: 'unexpected-bare-array',
    file: [para('a', 'Hello'), trailing],
    cls: 'unexpected',
    stage: 'S0→S1 seed prep',
    tag: 'legacy-bare-array→wrapper',
  },
  {
    name: 'unexpected-hand-formatted',
    file: null,
    raw: JSON.stringify({ blocks: [para('a', 'Hello'), trailing] }),
    cls: 'known',
    stage: 'S0→S1 seed prep',
    tag: 'formatting(indent/escapes)',
  },
  // Controls: a corrupted Yjs render must be flagged as collab-induced.
  {
    name: 'control-yjs-drops-block',
    file: { blocks: [para('a', 'Hello'), para('b', 'World'), trailing] },
    cls: 'unexpected',
    stage: 'S2→S3 Yjs',
    tag: 'block-dropped(paragraph)',
    fault: blocks => blocks.filter(b => (b as Obj).id !== 'b'),
    collabInduced: true,
  },
  {
    name: 'control-yjs-changes-text',
    file: { blocks: [para('a', 'Hello'), trailing] },
    cls: 'unexpected',
    stage: 'S2→S3 Yjs',
    tag: 'text-changed(paragraph)',
    fault: blocks =>
      blocks.map(b => ((b as Obj).id === 'a' ? { ...(b as Obj), content: [run('Hellp')] } : b)),
    collabInduced: true,
  },
  {
    name: 'control-yjs-drops-prop',
    file: { blocks: [para('a', 'Hello'), trailing] },
    cls: 'unexpected',
    stage: 'S2→S3 Yjs',
    tag: 'prop-dropped(paragraph.textAlignment)',
    fault: blocks =>
      blocks.map(b => {
        if ((b as Obj).id !== 'a') return b;
        const { textAlignment: _t, ...props } = (b as { props: Obj }).props;
        return { ...(b as Obj), props };
      }),
    collabInduced: true,
  },
];

const SELF_TEST_DECK: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  config: { transition: 'fade' },
  customCss: '.x { color: red; }',
  slides: [
    {
      id: 'aaaa0001',
      html: '<h1>One</h1>',
      notes: 'Say hi',
      attrs: { 'data-background-color': '#fff' },
    },
    {
      id: 'aaaa0002',
      children: [
        { id: 'aaaa0003', html: '<p>Two</p>' },
        { id: 'aaaa0004', html: '<p class="fragment">Three</p>', hidden: true },
      ],
    },
    { id: 'aaaa0005', html: '<pre><code>let a = 1;</code></pre>' },
  ],
} as DeckJson;

const SELF_TEST_DECK_CASES: Array<{
  name: string;
  deck: unknown;
  cls: DeckClass;
  stage?: string;
  tag?: string;
  fault?: DeckFault;
  collabInduced?: boolean;
}> = [
  { name: 'deck-canonical', deck: SELF_TEST_DECK, cls: 'identical' },
  {
    name: 'deck-runtime-attrs',
    deck: {
      ...SELF_TEST_DECK,
      slides: [
        {
          ...SELF_TEST_DECK.slides[0],
          attrs: { 'data-background-color': '#fff', style: 'top: 350px;' },
        },
        ...SELF_TEST_DECK.slides.slice(1),
      ],
    },
    cls: 'known',
    stage: 'D0→D1 load+prepare',
    tag: 'attr-dropped(style)',
  },
  {
    name: 'control-deck-drops-slide',
    deck: SELF_TEST_DECK,
    cls: 'unexpected',
    stage: 'D1→D2 Yjs',
    tag: 'slide-dropped',
    fault: deck => ({ ...deck, slides: deck.slides.filter(sl => sl.id !== 'aaaa0005') }),
    collabInduced: true,
  },
  {
    name: 'control-deck-changes-notes',
    deck: SELF_TEST_DECK,
    cls: 'unexpected',
    stage: 'D1→D2 Yjs',
    tag: 'slide-notes-changed',
    fault: deck => ({
      ...deck,
      slides: deck.slides.map(sl => (sl.id === 'aaaa0001' ? { ...sl, notes: 'Say hj' } : sl)),
    }),
    collabInduced: true,
  },
];

async function runSelfTest(out: string): Promise<boolean> {
  const root = join(out, 'selftest');
  rmSync(root, { recursive: true, force: true });
  let ok = true;
  for (const c of SELF_TEST_CASES) {
    const rel = `pages/${c.name}/content.json`;
    writeOut(join(root, 'pages', c.name), 'content.json', c.raw ?? JSON.stringify(c.file, null, 2));
    const r = await runPage('selftest', root, rel, join(out, 'selftest-out'), c.fault);
    const tags = c.stage ? (r.stages[c.stage] ?? []).map(d => d.tag) : [];
    const pass =
      r.cls === c.cls &&
      (!c.tag || tags.includes(c.tag)) &&
      r.collabInduced === (c.collabInduced ?? false);
    if (!pass) ok = false;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} ${c.name}: class=${r.cls} collabInduced=${r.collabInduced}` +
        (c.stage ? ` ${c.stage}=[${tags.join(', ')}]` : '') +
        (r.guard ? ` guard="${r.guard}"` : '') +
        (pass ? '' : ` (expected class=${c.cls}${c.tag ? ` tag=${c.tag}` : ''})`)
    );
  }
  for (const c of SELF_TEST_DECK_CASES) {
    const dirRel = `slides/${c.name}`;
    writeOut(join(root, dirRel), 'deck.json', JSON.stringify(c.deck, null, 2) + '\n');
    const r = await runDeck('selftest', root, dirRel, join(out, 'selftest-out'), c.fault);
    if (!r) throw new Error(`no deck result for ${c.name}`);
    const tags = c.stage ? (r.stages[c.stage] ?? []).map(d => d.tag) : [];
    const pass =
      r.cls === c.cls &&
      (!c.tag || tags.includes(c.tag)) &&
      r.collabInduced === (c.collabInduced ?? false);
    if (!pass) ok = false;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} ${c.name}: class=${r.cls} collabInduced=${r.collabInduced}` +
        (c.stage ? ` ${c.stage}=[${tags.join(', ')}]` : '') +
        (r.guard ? ` guard="${r.guard}"` : '') +
        (pass ? '' : ` (expected class=${c.cls}${c.tag ? ` tag=${c.tag}` : ''})`)
    );
  }
  return ok;
}

// ─── Driver ──────────────────────────────────────────────────────────────────

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function cloneRepo(full: string, reposDir: string): string {
  const dest = join(reposDir, full.split('/')[1]);
  if (!existsSync(dest)) {
    mkdirSync(reposDir, { recursive: true });
    execFileSync('gh', ['repo', 'clone', full, dest, '--', '--depth', '1', '--quiet'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }
  return dest;
}

function pad(s: string | number, n: number) {
  return String(s).padEnd(n);
}

function countTags(results: Array<{ stages: Record<string, Diff[]> }>) {
  const byStage = new Map<string, Map<string, Set<number>>>();
  results.forEach((r, i) => {
    for (const [stage, diffs] of Object.entries(r.stages)) {
      const m = byStage.get(stage) ?? new Map<string, Set<number>>();
      byStage.set(stage, m);
      for (const d of diffs) {
        const s = m.get(d.tag) ?? new Set<number>();
        s.add(i);
        m.set(d.tag, s);
      }
    }
  });
  return byStage;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reposDir = join(args.out, 'repos');
  mkdirSync(args.out, { recursive: true });
  // generateDeckHtml warns once per deck render (e.g. a shared theme without
  // resolved URLs); print each distinct warning once.
  const seenWarnings = new Set<string>();
  const warn = console.warn.bind(console);
  console.warn = (...parts: unknown[]) => {
    const key = parts.map(String).join(' ');
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warn(...parts);
  };
  if (args.selfTest) {
    const ok = await runSelfTest(args.out);
    console.log(ok ? 'self-test: all cases pass' : 'self-test: FAILURES');
    process.exit(ok ? 0 : 1);
  }
  rmSync(join(args.out, 'out'), { recursive: true, force: true });

  const roots: Array<{ name: string; root: string; cloned: boolean }> = [];
  for (const full of args.repos) {
    const existed = existsSync(join(reposDir, full.split('/')[1]));
    roots.push({ name: full.split('/')[1], root: cloneRepo(full, reposDir), cloned: !existed });
  }
  for (const dir of args.dirs) roots.push({ name: basename(dir), root: dir, cloned: false });

  const pages: PageResult[] = [];
  const decks: DeckResult[] = [];
  for (const { name, root } of roots) {
    let head = '?';
    try {
      head = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD']).toString().trim();
    } catch {
      /* not a git dir */
    }
    console.error(`[roundtrip] ${name}@${head}`);
    for (const slug of listDirs(join(root, 'pages'))) {
      const rel = `pages/${slug}/content.json`;
      if (existsSync(join(root, rel))) {
        try {
          pages.push(await runPage(name, root, rel, args.out));
        } catch (err) {
          pages.push({
            repo: name,
            path: rel,
            cls: 'unexpected',
            knownTags: [],
            stages: { harness: [{ tag: 'harness-error', detail: errMsg(err) }] },
            collabInduced: false,
            error: errMsg(err),
          });
        }
      } else if (existsSync(join(root, `pages/${slug}/index.html`))) {
        pages.push({
          repo: name,
          path: `pages/${slug}/index.html`,
          cls: 'legacy-html',
          knownTags: [],
          stages: {},
          collabInduced: false,
        });
      }
    }
    for (const slug of listDirs(join(root, 'slides'))) {
      try {
        const r = await runDeck(name, root, `slides/${slug}`, args.out);
        if (r) decks.push(r);
      } catch (err) {
        decks.push({
          repo: name,
          path: `slides/${slug}`,
          legacy: false,
          cls: 'unexpected',
          knownTags: [],
          stages: { harness: [{ tag: 'harness-error', detail: errMsg(err) }] },
          collabInduced: false,
          htmlVsStored: 'n/a',
          error: errMsg(err),
        });
      }
    }
  }

  // ── Summary (console: counts and tags only) ──
  const lines: string[] = [];
  const say = (s = '') => lines.push(s);
  say('## Pages');
  say();
  say(
    '| repo | files | identical | known | UNEXPECTED | of which collab-induced | legacy-html (seed refuses) | seed-throw | guard refusals | render-throws |'
  );
  say('|---|---|---|---|---|---|---|---|---|---|');
  for (const { name } of roots) {
    const rs = pages.filter(p => p.repo === name);
    const n = (f: (p: PageResult) => boolean) => rs.filter(f).length;
    say(
      `| ${name} | ${rs.length} | ${n(p => p.cls === 'identical')} | ${n(p => p.cls === 'known')} | ${n(p => p.cls === 'unexpected' || p.cls === 'parse-throw')} | ${n(p => p.collabInduced)} | ${n(p => p.cls === 'legacy-html')} | ${n(p => p.cls === 'seed-throw')} | ${n(p => !!p.guard)} | ${n(p => !!p.renderThrow)} |`
    );
  }
  say();
  say('## Decks');
  say();
  say(
    '| repo | decks | legacy html | identical | known | UNEXPECTED | of which collab-induced | seed-throw | guard refusals | today index.html == stored |'
  );
  say('|---|---|---|---|---|---|---|---|---|---|');
  for (const { name } of roots) {
    const rs = decks.filter(d => d.repo === name);
    const n = (f: (d: DeckResult) => boolean) => rs.filter(f).length;
    const comparable = rs.filter(
      d => d.htmlVsStored === 'same' || d.htmlVsStored.startsWith('differs')
    );
    say(
      `| ${name} | ${rs.length} | ${n(d => d.legacy)} | ${n(d => d.cls === 'identical')} | ${n(d => d.cls === 'known')} | ${n(d => d.cls === 'unexpected')} | ${n(d => d.collabInduced)} | ${n(d => d.cls === 'seed-throw')} | ${n(d => !!d.guard)} | ${n(d => d.htmlVsStored === 'same')}/${comparable.length} |`
    );
  }
  say();
  const known = new Map<string, number>();
  for (const r of [...pages, ...decks]) {
    if (r.cls === 'known') for (const t of r.knownTags) known.set(t, (known.get(t) ?? 0) + 1);
  }
  say('## Known normalizations (files)');
  say();
  for (const [t, c] of [...known].sort((a, b) => b[1] - a[1])) say(`- ${t}: ${c}`);
  say();
  const tagSection = (title: string, rs: Array<{ stages: Record<string, Diff[]> }>) => {
    say(`## ${title}: diff tags per stage (files affected, all classes)`);
    say();
    for (const [stage, m] of countTags(rs)) {
      say(`### ${stage}`);
      for (const [tag, set] of [...m].sort((a, b) => b[1].size - a[1].size)) {
        say(`- ${tag}: ${set.size}`);
      }
      say();
    }
  };
  tagSection('Pages', pages);
  tagSection('Decks', decks);
  const summary = lines.join('\n');
  console.log(summary);

  // ── report.md (values allowed: /tmp only) ──
  const rep: string[] = [
    '# Live-editing round trip over real content',
    '',
    `Generated ${new Date().toISOString()} by scripts/collab-dev/roundtrip/run.ts.`,
    `Repos: ${roots.map(r => r.name).join(', ')}. Stage outputs: ${join(args.out, 'out')}/<repo>/<path>/.`,
    '',
    summary,
    '',
    '## Per-file detail: every UNEXPECTED / collab-induced / refused file',
    '',
  ];
  const detail = (r: PageResult | DeckResult) => {
    rep.push(`### ${r.repo}/${r.path} — ${r.cls}${r.collabInduced ? ' — COLLAB-INDUCED' : ''}`);
    if (r.error) rep.push(`- error: ${r.error}`);
    if (r.guard) rep.push(`- worker guard: ${r.guard}`);
    if ('renderThrow' in r && r.renderThrow)
      rep.push(
        `- blocksToFullHTML threw: ${r.renderThrow}${r.renderThrowPre ? ` (also before Yjs: ${r.renderThrowPre})` : ''}`
      );
    if ('htmlVsStored' in r) rep.push(`- today's index.html vs stored: ${r.htmlVsStored}`);
    if (r.knownTags.length) rep.push(`- tags vs original: ${r.knownTags.join(', ')}`);
    for (const [stage, diffs] of Object.entries(r.stages)) {
      rep.push(`- **${stage}** (${diffs.length})`);
      for (const d of diffs.slice(0, 25)) rep.push(`  - \`${d.tag}\` — ${d.detail}`);
      if (diffs.length > 25) rep.push(`  - … ${diffs.length - 25} more`);
    }
    rep.push('');
  };
  for (const r of pages) {
    if (
      r.cls === 'unexpected' ||
      r.cls === 'parse-throw' ||
      r.cls === 'seed-throw' ||
      r.collabInduced ||
      r.guard ||
      r.renderThrow
    )
      detail(r);
  }
  for (const r of decks) {
    if (r.cls === 'unexpected' || r.cls === 'seed-throw' || r.collabInduced || r.guard) detail(r);
  }
  rep.push('## Decks whose regenerated index.html differs from the stored one (informational)');
  rep.push('');
  for (const r of decks.filter(d => d.htmlVsStored.startsWith('differs'))) {
    rep.push(`- ${r.repo}/${r.path}: ${r.htmlVsStored}`);
  }
  rep.push('');
  rep.push("## Legacy decks: parseDeckHtml warnings (same on today's load)");
  rep.push('');
  for (const r of decks.filter(d => d.parseWarnings?.length)) {
    rep.push(`- ${r.repo}/${r.path}: ${r.parseWarnings!.join(' | ')}`);
  }
  writeOut(args.out, 'report.md', rep.join('\n') + '\n');
  writeOut(
    args.out,
    'results.json',
    JSON.stringify(
      {
        pages: pages.map(p => ({ ...p, stages: mapTags(p.stages) })),
        decks: decks.map(d => ({ ...d, stages: mapTags(d.stages) })),
      },
      null,
      2
    )
  );
  console.error(`[roundtrip] report: ${join(args.out, 'report.md')}`);

  if (!args.keep) {
    for (const r of roots) if (r.cloned) rmSync(r.root, { recursive: true, force: true });
  }
}

function mapTags(stages: Record<string, Diff[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(stages)) out[k] = [...new Set(v.map(d => d.tag))];
  return out;
}

await main();
process.exit(0);

export type { Json };
