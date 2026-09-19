/**
 * BlockNote `content.json` → plain text, for the content index.
 *
 * A prop-aware depth-first walker, NOT a render-and-strip. The renderer
 * (`ServerBlockNoteEditor`, driven through `withServerBlockNoteLock`,
 * `apps/pages/app/site/render.server.ts:51`) swaps `globalThis.window` and
 * `globalThis.document` for a JSDOM pair while it serializes; an indexer that
 * runs on every save would contend for that lock with live page renders, and
 * two of the shims around it (`installStorageShim`, `drainReactWork`) exist
 * because failures there surface as uncaught exceptions rather than as failed
 * renders. Rendering to HTML and stripping tags is also lossy in exactly the
 * wrong place: BlockNote's HTML serializer writes every block prop onto the
 * wrapper as a `data-*` attribute (`apps/pages/app/site/redact.server.ts:11-13`),
 * so a tag strip deletes the prop text this file exists to keep.
 *
 * What the walker fixes, relative to `collectText`
 * (`apps/mcp/src/tools/pageContent.ts:69-82`):
 *   1. `children` is recursed — without it a `columnList` is empty, and so is
 *      every list item nested under another one;
 *   2. `props` are read — 11 of the 21 block types in this app's schema carry
 *      ALL of their text there and none of it in `content`;
 *   3. blocks are newline-separated, so a heading and the paragraph after it
 *      do not run together.
 *
 * Schema: `apps/pages/app/components/editor/blocks/index.tsx:54-71`
 * (BlockNote 0.46.2 defaults minus audio/video/codeBlock/image, plus
 * `multiColumnSchema.blockSpecs`, plus nine overrides) — 21 distinct types.
 *
 * Imports nothing. Takes JSON in, returns text out.
 */

// ─── navGrid entries ─────────────────────────────────────────────────────────
//
// Reduced copy of `apps/pages/app/components/editor/blocks/navGridShared.ts`
// (`sanitizeNavGridUrl` :88, `parseEntry` :103, `parseNavGridEntries` :160).
// `packages/services` must not depend on `apps/pages`, and that file is the one
// block file with no React and no DOM, so copying it is cheap.
//
// This copy keeps only what identifies an entry's TARGET. Labels are dropped on
// the floor here — see the reference rule below — so `navGridEntryLabel`, the
// emoji helpers, serialization, column normalization and the reorder helper are
// all absent.
//
// `entries` is a JSON-encoded STRING because BlockNote props must be primitives
// (`navGridShared.ts:3-8`). It must not be hand-parsed with a regex.

/** Protocols an external entry may link to (`navGridShared.ts:63`). */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `navGridShared.ts:88` — bare hosts get a scheme; only http/https/mailto survive. */
function sanitizeNavGridUrl(value: unknown): string | null {
  const raw = asString(value).trim();
  if (!raw) return null;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * A pointer at something OTHER than this document.
 *
 * `id` is a page id for `kind: 'page'`, a sanitized absolute URL for
 * `kind: 'external'`, and '' for `kind: 'schedule'` — the schedule has no
 * target, it lives at `/schedule` on the class site and nowhere else
 * (`navGridShared.ts:29-37`).
 *
 * No label rides along on purpose: the stored label is a stale denormalized
 * copy of the target's title, and a caller that can authorize the target can
 * also read its current title.
 */
export interface ContentReference {
  kind: 'page' | 'external' | 'schedule';
  id: string;
}

/** `navGridShared.ts:103`, reduced to the target. */
function parseNavGridReference(value: unknown): ContentReference | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  if (raw.kind === 'page') {
    const pageId = asString(raw.pageId) || asString(raw.page_id);
    return pageId ? { kind: 'page', id: pageId } : null;
  }
  if (raw.kind === 'external') {
    const url = sanitizeNavGridUrl(raw.url);
    return url ? { kind: 'external', id: url } : null;
  }
  if (raw.kind === 'schedule') {
    return { kind: 'schedule', id: '' };
  }
  return null;
}

/** `navGridShared.ts:160` — never throws; bad entries degrade to fewer entries. */
function parseNavGridReferences(value: unknown): ContentReference[] {
  let source: unknown = value;

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) return [];

  const refs: ContentReference[] = [];
  for (const item of source) {
    const ref = parseNavGridReference(item);
    if (ref) refs.push(ref);
  }
  return refs;
}

// ─── The prop table ──────────────────────────────────────────────────────────

/**
 * Props that carry this document's OWN words, by block type. A whitelist on
 * purpose: emitting every string prop would put `backgroundColor: 'default'`,
 * `textAlignment: 'left'`, every asset URL and every `language: 'bash'` into
 * the embedding.
 *
 * Types absent from this table carry no extractable prop text:
 *   inline content, no text props — paragraph, heading, bulletListItem,
 *     numberedListItem, checkListItem, toggleListItem, quote, codeBlock, callout
 *   table content                 — table (text lives in content.rows[].cells[])
 *   no content, no text props     — divider, embed (url/type only),
 *                                   columnList, column (all text is in children)
 *   cross-references              — pageLink, navGrid (see below)
 *
 * `pageLink.pageTitle` and every `navGrid` label are in the editor schema and
 * are NOT here, deliberately. They are denormalized copies of ANOTHER
 * document's title, and this document's draft state says nothing about that
 * one's: a published homepage that links to a draft would otherwise put "Exam 2
 * Solutions" into a student-visible snippet. The live site draws the same line
 * — `apps/pages/app/site/redact.server.ts:9` documents the leak, `:67` strips
 * unauthorized page links, `:76` filters nav-grid entries — and resolves each
 * title from the DB per viewer rather than trusting the stored copy
 * (`viewerSchema.server.ts:355-363`: "the denormalized title in the block props
 * is a stale copy we must not print on the visitor's behalf"). So the extractor
 * returns the TARGETS in `references` and none of their labels in `text`; a
 * caller that has a viewer context can resolve and authorize them later.
 *
 * A block type added to the editor schema without a line here loses its prop
 * text silently. The schema is a React module and cannot be imported from
 * server-only code, so the coupling is this comment plus the
 * `covers every block type in the editor schema` test, not a type error.
 */
const PROP_TEXT_KEYS: Record<string, readonly string[]> = {
  file: ['name', 'caption'],
  image: ['caption', 'name'],
  video: ['caption'],
  terminal: ['code', 'title'],
  profile: ['name', 'title', 'links'],
};

/** Every block type in this app's editor schema, for the coverage test. */
export const KNOWN_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'toggleListItem',
  'quote',
  'codeBlock',
  'callout',
  'table',
  'file',
  'image',
  'video',
  'divider',
  'embed',
  'columnList',
  'column',
  'terminal',
  'profile',
  'pageLink',
  'navGrid',
] as const;

// ─── The walker ──────────────────────────────────────────────────────────────

interface BlockNode {
  type?: string;
  props?: unknown;
  content?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

interface Sink {
  text: string[];
  refs: ContentReference[];
}

/**
 * Inline text reachable through `content`: styled text runs, link children, and
 * a table's `cells` → `content`.
 *
 * Runs are joined by the CALLER with no separator, because BlockNote splits a
 * styled sentence mid-word (`[{text:'hello '},{text:'world'}]`) and a space
 * between them would double the one already there.
 */
function collectInline(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectInline(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.text === 'string') out.push(record.text);
  for (const key of ['content', 'cells']) {
    if (record[key]) collectInline(record[key], out);
  }
}

/** A table renders one line per row, so rows do not run together. */
function tableLines(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const rows = (content as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) {
    const parts: string[] = [];
    collectInline(content, parts);
    return parts.join('');
  }
  const lines: string[] = [];
  for (const row of rows) {
    const cellParts: string[] = [];
    const cells = row && typeof row === 'object' ? (row as Record<string, unknown>).cells : null;
    if (Array.isArray(cells)) {
      for (const cell of cells) {
        const parts: string[] = [];
        collectInline(cell, parts);
        const cellText = parts.join('').trim();
        if (cellText) cellParts.push(cellText);
      }
    } else {
      collectInline(row, cellParts);
    }
    const line = cellParts.join(' ').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function propText(props: unknown, key: string): string {
  if (!props || typeof props !== 'object') return '';
  const value = (props as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function collectBlock(block: unknown, sink: Sink): void {
  if (!block || typeof block !== 'object') return;
  if (Array.isArray(block)) {
    for (const item of block) collectBlock(item, sink);
    return;
  }

  const node = block as BlockNode;
  const type = typeof node.type === 'string' ? node.type : '';

  // 1. inline content (or a table's rows)
  if (node.content !== undefined && node.content !== null) {
    let inline: string;
    if (type === 'table') {
      inline = tableLines(node.content);
    } else {
      const parts: string[] = [];
      collectInline(node.content, parts);
      inline = parts.join('');
    }
    const trimmed = inline.trim();
    if (trimmed) sink.text.push(trimmed);
  }

  // 2. prop-carried text — the whole point; `collectText` never even received
  //    `props`, because its only caller passed `block.content`.
  for (const key of PROP_TEXT_KEYS[type] ?? []) {
    const value = propText(node.props, key);
    if (value) sink.text.push(value);
  }

  // 3. cross-references — target out, label dropped. See PROP_TEXT_KEYS.
  if (type === 'pageLink') {
    const pageId = propText(node.props, 'pageId');
    if (pageId) sink.refs.push({ kind: 'page', id: pageId });
  }
  if (type === 'navGrid') {
    sink.refs.push(...parseNavGridReferences(propText(node.props, 'entries')));
  }

  // 4. children — a `columnList` has no content and no text props at all, so
  //    skipping this loses the entire column layout.
  if (node.children) collectBlock(node.children, sink);
}

/**
 * Normalize the two stored shapes of `content.json`.
 *
 * `pageContent.service.ts:146-159` reads both: the `{ blocks, coverImage? }`
 * wrapper written today, and the bare blocks array written before the wrapper
 * existed. Both shapes are live in production content repos right now — a
 * surveyed course had 12 of its 13 BlockNote pages on the wrapper and one
 * still a bare array — so accepting only the array (as the plan's signature
 * suggested) would silently index nothing for most pages.
 */
function toBlocks(json: unknown): unknown[] | null {
  let parsed: unknown = json;

  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const blocks = (parsed as Record<string, unknown>).blocks;
    if (Array.isArray(blocks)) return blocks;
  }
  return null;
}

function dedupe(refs: ContentReference[]): ContentReference[] {
  const seen = new Set<string>();
  const out: ContentReference[] = [];
  for (const ref of refs) {
    const key = `${ref.kind} ${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export interface BlockNoteText {
  text: string;
  references: ContentReference[];
  /** Set when the document could not be read at all. */
  error?: string;
}

/** BlockNote `content.json` → plain text plus its outbound references. Never throws. */
export function extractBlockNoteText(json: unknown): BlockNoteText {
  // Absent is an empty document. Present-but-unreadable is a failure, and the
  // two must not collapse into the same empty string for the indexer.
  if (json === null || json === undefined) return { text: '', references: [] };
  if (typeof json === 'string' && !json.trim()) return { text: '', references: [] };

  const blocks = toBlocks(json);
  if (!blocks) {
    return {
      text: '',
      references: [],
      error: 'page content could not be parsed: not a BlockNote document',
    };
  }
  const sink: Sink = { text: [], refs: [] };
  collectBlock(blocks, sink);
  return { text: sink.text.join('\n'), references: dedupe(sink.refs) };
}
