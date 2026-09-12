/**
 * `.mdx` documentation page → plain text, for the docs index.
 *
 * ── What this is, and what it is NOT ───────────────────────────────────────
 * The sibling `html.ts` / `blocknote.ts` extractors read COURSE content, which
 * arrives as generated HTML or as a structured editor document. This one reads
 * the product documentation: hand-written `.mdx` under
 * `apps/site/src/content/docs`, which is Markdown plus a small, fully
 * enumerated set of Astro components.
 *
 * It PARSES. It never executes, never imports a component, never resolves an
 * import specifier and never fetches anything an attribute names. Retrieved
 * documentation text is EVIDENCE for an answer, never an instruction to follow:
 * a page that says "run this command" is a page the assistant may quote, not a
 * page that makes anything run.
 *
 * ── Why hand-rolled rather than an MDX parser ──────────────────────────────
 * Not because a real parser is impossible here — a dynamically imported one
 * would stay off every app's startup graph, exactly as this file does. Because
 * the corpus is 25 files that are fully enumerated below, the failure modes are
 * named, and the resulting contract is testable line by line. A mistake is
 * recoverable by bumping {@link MDX_EXTRACT_VERSION}, which re-indexes every
 * page on the next reconcile.
 *
 * ── THE CORPUS, AS OF THE DAY THIS WAS WRITTEN ─────────────────────────────
 * Frontmatter  25/25 single-line unquoted `title` + `description`, nothing else.
 * Imports      55 single-line default imports (22 `.astro`, 33 `.png`).
 * JSX          27 `Screenshot`, 6 `Video`, 1 `DocCards`, 6 diagrams across five
 *              types. All self-closing; every `Video` and the `DocCards` block
 *              is multiline.
 * Fences       18 (9 bash, 5 json, 1 env, 1 js, 2 untyped). Tables: 15 pipe
 *              tables, 8 of them env-var tables.
 * Also         headings, nested lists, emphasis, inline code, links, one
 *              thematic break, 8 `:::note` pairs.
 * Absent       HTML/MDX comments, paired JSX tags, blockquotes, tilde fences,
 *              `![](…)` images, `<img>`.
 *
 * Anything outside that inventory is a REFUSAL, not a guess — see the fail
 * closed rules below. "Present in the repo" must not silently become
 * "publishable", and a shape nobody has looked at is a reason to stop.
 *
 * ── ORDER IS THE WHOLE DESIGN ──────────────────────────────────────────────
 * Code is protected FIRST, before any other rule runs. Strip emphasis before
 * protecting code and `context_servers` becomes `contextservers`,
 * `TRIGGER_SECRET_KEY` becomes `TRIGGERSECRETKEY`, and the index answers
 * configuration questions with identifiers that do not exist. Every later pass
 * therefore runs over opaque sentinels, and the originals are put back last,
 * byte for byte.
 *
 * Pure: no DOM, no cheerio, no JSON, no `@classmoji/database`. Bytes in, text
 * out, never throws.
 */

/**
 * The extractor's version, stamped on every row it produces.
 *
 * THE SINGLE AUTHORITY. `docsIndex.service.ts` re-exports this constant rather
 * than declaring one of its own: two version numbers that must agree is a bug
 * waiting for the day they do not, and the whole recovery story for an
 * extractor mistake is "bump this, the next reconcile re-indexes everything".
 */
export const MDX_EXTRACT_VERSION = 1;

/** The eight components the docs actually use. Anything else is a refusal. */
export const KNOWN_MDX_COMPONENTS = [
  'Screenshot',
  'Video',
  'DocCards',
  'ModulesDiagram',
  'GithubMappingDiagram',
  'RolesDiagram',
  'GradeCalculationDiagram',
  'RepositoryPublishDiagram',
] as const;

/**
 * What a component contributes to the text, if anything.
 *
 * `alt` (and `Video`'s `title`) is the only attribute harvested, and it is
 * harvested ATTRIBUTED — prefixed with the component name — and immediately
 * followed by that component's own `caption`, because the two can say different
 * things about the same picture. `roster.mdx` is the worked example: its alt
 * describes "a TA with a grader-role toggle" while its caption says "An earlier
 * version of this screen, from when it listed assistants only". Harvesting the
 * alt alone would put a screenshot's description into the corpus as though it
 * were current product behaviour.
 *
 * `url` is deliberately NOT harvested. `Screenshot.astro` renders it as display
 * text inside a simulated browser frame, and the values are example classroom
 * paths (`app.classmoji.io/admin/cs-101/students`) and localhost addresses — a
 * picture of a URL, not a destination. Indexing them would have the assistant
 * hand people links to a classroom that does not exist.
 *
 * Components with no entry here contribute NOTHING. `DocCards` is the notable
 * one: its cards are a nested JS array of `{emoji, title, description, href}`,
 * and harvesting those would mean evaluating an attribute expression and
 * emitting navigation URLs. The diagrams are pure illustration with no text.
 */
const HARVEST: Record<string, { label: string; primary: string } | undefined> = {
  Screenshot: { label: 'Screenshot', primary: 'alt' },
  Video: { label: 'Video', primary: 'title' },
};

/** The second attribute harvested, always alongside (never instead of) the first. */
const CAPTION_ATTR = 'caption';

export interface ExtractedMdx {
  /**
   * False when the source is a shape this extractor has not been taught.
   *
   * `text` is '' in that case. The caller is expected to branch on this and
   * KEEP whatever it had: an unreadable page is a reason to go on answering out
   * of the previous version, not to blank the page out of the corpus.
   */
  ok: boolean;
  /** Frontmatter `title`. '' when `ok` is false. */
  title: string;
  /** Frontmatter `description`, or null when the page has none. */
  description: string | null;
  /** Title, description and body as one string, ready to embed. */
  text: string;
  /** Why `ok` is false. Absent when `ok`. */
  error?: string;
}

const fail = (error: string): ExtractedMdx => ({
  ok: false,
  title: '',
  description: null,
  text: '',
  error,
});

// ─── Pass 0: protect code ───────────────────────────────────────────────────

/**
 * The sentinel wrapper.
 *
 * NUL is the one byte no rule below looks at: it is not `#`, `-`, `*`, `_`,
 * `|`, `<`, `[`, `(` or a backtick, it is not a word character (so the
 * word-boundary emphasis rules skip it), and it cannot occur in a `.mdx` file
 * anybody wrote. A printable sentinel would eventually collide with prose.
 */
const SENTINEL_OPEN = '\u0000';
const SENTINEL_CLOSE = '\u0000';
const sentinel = (index: number): string => `${SENTINEL_OPEN}${index}${SENTINEL_CLOSE}`;

/** Every code span and fenced block, in the order they were taken out. */
type CodeStash = string[];

/**
 * Replace fenced blocks and inline code spans with sentinels.
 *
 * Fences first, because a fenced block may contain backticks that are not a
 * code span (`json` bodies containing markdown, shell heredocs), and inline
 * scanning inside one would tear it apart.
 *
 * The fence DELIMITERS and the language tag are discarded; the body is stashed.
 * A code span's backticks are discarded the same way. What comes back at the
 * end is what a reader would copy: the command, the identifier, the JSON — and
 * nothing that only existed to mark it as code.
 */
function protectCode(source: string): { text: string; stash: CodeStash } {
  const stash: CodeStash = [];
  const lines = source.split('\n');
  const out: string[] = [];

  for (let at = 0; at < lines.length; at += 1) {
    const open = /^(\s*)(`{3,})(.*)$/.exec(lines[at]);
    if (!open) {
      out.push(lines[at]);
      continue;
    }

    // An opening fence. Its closer is the first later line that is nothing but
    // at least as many backticks. No closer before EOF means the rest of the
    // file is code — which is what a reader's editor shows too.
    const ticks = open[2].length;
    const body: string[] = [];
    let cursor = at + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (new RegExp(`^\\s*\`{${ticks},}\\s*$`).test(lines[cursor])) break;
      body.push(lines[cursor]);
    }
    stash.push(body.join('\n'));
    out.push(open[1] + sentinel(stash.length - 1));
    at = cursor; // the closing fence line itself is consumed
  }

  return { text: protectInlineCode(out.join('\n'), stash), stash };
}

/**
 * Inline code spans, with CommonMark's longest-run rule.
 *
 * A span opens with a run of N backticks and closes at the next run of EXACTLY
 * N. That is what keeps `` `a ` b` `` — a span containing a backtick — in one
 * piece instead of two. An unclosed run is not a span and is left alone.
 */
function protectInlineCode(source: string, stash: CodeStash): string {
  let out = '';
  let at = 0;

  while (at < source.length) {
    if (source[at] !== '`') {
      out += source[at];
      at += 1;
      continue;
    }

    let openEnd = at;
    while (openEnd < source.length && source[openEnd] === '`') openEnd += 1;
    const ticks = openEnd - at;

    // Look for a closing run of exactly this length.
    let cursor = openEnd;
    let closeStart = -1;
    while (cursor < source.length) {
      if (source[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let runEnd = cursor;
      while (runEnd < source.length && source[runEnd] === '`') runEnd += 1;
      if (runEnd - cursor === ticks) {
        closeStart = cursor;
        break;
      }
      cursor = runEnd;
    }

    if (closeStart === -1) {
      // Not a span at all. Emit the backticks as the literal text they are.
      out += source.slice(at, openEnd);
      at = openEnd;
      continue;
    }

    stash.push(source.slice(openEnd, closeStart));
    out += sentinel(stash.length - 1);
    at = closeStart + ticks;
  }

  return out;
}

/** Put every stashed original back, byte for byte. */
function restoreCode(text: string, stash: CodeStash): string {
  return text.replace(
    new RegExp(`${SENTINEL_OPEN}(\\d+)${SENTINEL_CLOSE}`, 'g'),
    (whole, index: string) => {
      const original = stash[Number(index)];
      return original === undefined ? whole : original;
    }
  );
}

// ─── Pass 1: frontmatter, fail closed ───────────────────────────────────────

interface Frontmatter {
  title: string;
  description: string | null;
  /** Where the body starts, as an index into the line array. */
  bodyLine: number;
}

const isDelimiter = (line: string): boolean => /^---\s*$/.test(line);

/**
 * Parse the frontmatter block, refusing anything unfamiliar.
 *
 * Only single-line `key: value` is accepted, quoted with one matching pair of
 * `'` or `"` or not at all. A block scalar (`|`, `>`), a value continued on the
 * next line, a missing closing delimiter or a missing/empty `title` is a hard
 * refusal, NOT a best guess.
 *
 * The reason is the one in the file header: a frontmatter shape nobody has
 * looked at may carry a `draft: true`, an `excluded` flag or a custom `slug`,
 * and an extractor that shrugs at unfamiliar keys is an extractor that
 * publishes a draft. Unknown keys with a plain scalar value are ignored, which
 * is safe; an unknown SHAPE is not.
 */
function parseFrontmatter(lines: string[]): Frontmatter | { error: string } {
  if (lines.length === 0 || !isDelimiter(lines[0])) return { error: 'frontmatter_missing' };

  let close = -1;
  for (let at = 1; at < lines.length; at += 1) {
    if (isDelimiter(lines[at])) {
      close = at;
      break;
    }
  }
  if (close === -1) return { error: 'frontmatter_unterminated' };

  let title = '';
  let description: string | null = null;

  for (let at = 1; at < close; at += 1) {
    const line = lines[at];
    if (line.trim() === '') continue;

    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    // No `key:` at the start of the line means this is a continuation of the
    // one above, or a nested mapping, or a list item — all shapes this refuses.
    if (!pair) return { error: 'frontmatter_unparsed' };

    const key = pair[1];
    const raw = pair[2].trim();
    if (/^[|>][-+0-9]*$/.test(raw)) return { error: 'frontmatter_block_scalar' };

    const value = unquote(raw);
    if (key === 'title') title = value;
    else if (key === 'description') description = value === '' ? null : value;
  }

  if (title === '') return { error: 'frontmatter_missing_title' };
  return { title, description, bodyLine: close + 1 };
}

/** One matching pair of surrounding quotes, or the value unchanged. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  }
  return value;
}

// ─── Pass 2: imports ────────────────────────────────────────────────────────

/** `import X from './y.png';` — the only import shape the corpus has. */
const IMPORT_LINE = /^import\s+[A-Za-z_$][\w$]*\s+from\s+(['"])[^'"]+\1;?\s*$/;

/** Anything that LOOKS like an import statement, for the refusal below. */
const IMPORT_ISH = /^import\s.*\sfrom\s/;

// ─── Pass 3: JSX ────────────────────────────────────────────────────────────

interface TagScan {
  /** Where the tag ends, exclusive, as an index into the whole body string. */
  end: number;
  /** True for `/>`; a bare `>` means a paired element, which is refused. */
  selfClosing: boolean;
}

/**
 * Find the end of a JSX tag that starts at `from`, string-aware.
 *
 * A depth-only scanner is not enough and the corpus proves it: `grading.mdx:19`
 * carries `alt="Settings > Grades showing the emoji-to-value mappings…"`, and a
 * scanner that stops at the first `>` truncates that alt mid-sentence and
 * leaves `…button" frame url="…" size="lg" />` behind as prose. So quoted
 * attribute strings are tracked, and `{}`/`[]`/`()` nesting is counted only
 * OUTSIDE them — which is also what lets the multiline `<Video>` blocks and
 * `DocCards`' nested array close correctly.
 */
function scanTag(body: string, from: number): TagScan | null {
  let quote: string | null = null;
  let depth = 0;

  for (let at = from; at < body.length; at += 1) {
    const ch = body[at];

    if (quote) {
      if (ch === '\\') at += 1;
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;

    if (ch === '/' && body[at + 1] === '>') return { end: at + 2, selfClosing: true };
    if (ch === '>') return { end: at + 1, selfClosing: false };
  }

  return null;
}

/**
 * Read one string-valued attribute out of a tag.
 *
 * String literals only. `src={img}` and `poster={getStartedIntroImg.src}` are
 * expressions: this never evaluates one, never resolves what it names and never
 * fetches it. An attribute whose value is an expression simply has no value
 * here.
 */
function stringAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`);
  const found = pattern.exec(tag);
  return found ? found[2].trim() : null;
}

/**
 * Replace every JSX element with its harvested text (usually nothing).
 *
 * Returns an error instead when the corpus has grown a shape nobody decided
 * about: an unknown component name, a paired element, or a tag that never
 * closes. A new component is a DECISION — does its text belong in the corpus,
 * and under what attribution — not something to delete quietly and ship.
 */
function stripJsx(body: string): { text: string } | { error: string } {
  let out = '';
  let at = 0;

  while (at < body.length) {
    // A block opens at the first NON-SPACE characters of a line: `<`
    // mid-sentence is prose, and the corpus has no inline JSX.
    //
    // The indentation matters. Gating on `body[at - 1] === '\n'` — column zero
    // only — means an indented component, the shape a nested list item or a
    // `:::note` body produces, is never recognised as a component at all. It is
    // copied out as prose, which silently defeats the whole fail-closed rule
    // below: `  <NewThing prop="x" />` inside a list would reach the corpus as
    // text instead of refusing the page, and a `<Screenshot>` indented the same
    // way would spill `/>` and lose its alt.
    if (!atFirstNonSpace(body, at) || body[at] !== '<') {
      out += body[at];
      at += 1;
      continue;
    }

    const name = /^<([A-Za-z][A-Za-z0-9]*)/.exec(body.slice(at, at + 64));
    if (!name || !/^[A-Z]/.test(name[1])) {
      out += body[at];
      at += 1;
      continue;
    }

    const component = name[1];
    if (!(KNOWN_MDX_COMPONENTS as readonly string[]).includes(component)) {
      return { error: 'unknown_component' };
    }

    const scanned = scanTag(body, at);
    if (!scanned) return { error: 'unclosed_component' };
    if (!scanned.selfClosing) return { error: 'paired_component' };

    const tag = body.slice(at, scanned.end);
    out += harvest(component, tag);
    at = scanned.end;
  }

  return { text: out };
}

/**
 * Is `at` the first character of its line that is not a space or a tab?
 *
 * Leading whitespace only — nothing else may intervene, so `text <Thing/>` and
 * `- <Thing/>` are still prose and a bullet is not a licence to open a block.
 */
function atFirstNonSpace(body: string, at: number): boolean {
  let back = at - 1;
  while (back >= 0 && (body[back] === ' ' || body[back] === '\t')) back -= 1;
  return back < 0 || body[back] === '\n';
}

/** The lines one component contributes, attributed, with its caption kept. */
function harvest(component: string, tag: string): string {
  const rule = HARVEST[component];
  if (!rule) return '';

  const lines: string[] = [];
  const primary = stringAttribute(tag, rule.primary);
  if (primary) lines.push(`${rule.label}: ${primary}`);
  const caption = stringAttribute(tag, CAPTION_ATTR);
  if (caption) lines.push(caption);

  return lines.length ? lines.join('\n') : '';
}

// ─── Pass 4: markdown ───────────────────────────────────────────────────────

/** `:::note`, `:::tip`, `:::caution`, `:::danger` and the bare `:::` closer. */
const DIRECTIVE_MARKER = /^\s*:::[A-Za-z]*\s*$/;
/** A thematic break, once frontmatter is already gone. */
const THEMATIC_BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** A pipe-table row, header separator included. */
const TABLE_ROW = /^\s*\|/;
/** A bullet or an ordered-list marker at the head of a line. */
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * Markdown syntax → prose, one line at a time.
 *
 * TABLES ARE LEFT EXACTLY AS THEY ARE. Eight of the fifteen tables in the
 * corpus are env-var tables, where the association between a name, whether it
 * is required, its default and its description IS the content. Reflowing those
 * cells into a sentence, or dropping an empty "Default" cell, produces text
 * that reads fluently and answers wrongly. Pipes cost a few characters and keep
 * every row's columns lined up with its header.
 */
function markdownToText(body: string): string {
  return body
    .split('\n')
    .map(line => {
      if (TABLE_ROW.test(line)) return line;
      if (DIRECTIVE_MARKER.test(line)) return '';
      if (THEMATIC_BREAK.test(line)) return '';

      // A HEADING IS NOT ALSO A LIST ITEM. Running both strips over the same
      // line ate the ordinal of `## 1. Fork and clone the repo`: the heading
      // rule left `1. Fork and clone the repo`, which the list rule then read
      // as a numbered bullet. The five steps of the local-development guide all
      // came out unnumbered, so "step 3" in the prose pointed at nothing and a
      // model reassembling the order had to guess it.
      const heading = /^\s*#{1,6}\s+/.exec(line);
      let out = heading ? line.slice(heading[0].length) : line.replace(LIST_MARKER, '');
      out = stripEmphasis(out);
      out = collapseLinks(out);
      return out;
    })
    .join('\n');
}

/**
 * Drop emphasis markers, ONLY at word boundaries.
 *
 * `snake_case_identifiers` and `__dunder__` names appear in prose outside code
 * spans, and a naive `_` strip turns `_acme-challenge` into `acme-challenge` —
 * a DNS record name that does not exist. Requiring a non-word character (or the
 * line edge) on the outside of each marker is what separates emphasis from an
 * identifier.
 */
function stripEmphasis(line: string): string {
  return line
    .replace(/\*\*(?=\S)([^*]*\S)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*\S)\*(?![*\w])/g, '$1$2')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*\S)_(?![_\w])/g, '$1$2');
}

/** `[text](url)` → `text`, and `![alt](url)` → `alt`. The URL is dropped. */
function collapseLinks(line: string): string {
  return line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

// ─── The extractor ──────────────────────────────────────────────────────────

/**
 * Extract plain text from one documentation `.mdx` page.
 *
 * NEVER THROWS. The indexer runs it over 25 files in a loop and reports per
 * page; an exception there would abandon the pages after it.
 */
export function extractMdxText(source: string): ExtractedMdx {
  if (typeof source !== 'string' || source.trim() === '') return fail('empty_source');

  try {
    // Pass 0 — code first, before any rule that could rewrite an identifier.
    const protectedSource = protectCode(source.replace(/\r\n/g, '\n'));
    const lines = protectedSource.text.split('\n');

    // Pass 1 — frontmatter, fail closed.
    const front = parseFrontmatter(lines);
    if ('error' in front) return fail(front.error);

    // Pass 2 — imports.
    const bodyLines: string[] = [];
    for (const line of lines.slice(front.bodyLine)) {
      if (IMPORT_LINE.test(line)) continue;
      // An import-shaped line that is not the shape above — a brace import, a
      // multiline one — is a refusal rather than prose leaked into the corpus.
      if (IMPORT_ISH.test(line)) return fail('unknown_import');
      bodyLines.push(line);
    }

    // Pass 3 — JSX.
    const stripped = stripJsx(bodyLines.join('\n'));
    if ('error' in stripped) return fail(stripped.error);

    // Pass 4 — markdown.
    const prose = markdownToText(stripped.text);

    // Pass 5 — assemble, then put the code back LAST so it is exactly what it
    // was. (The plan collapses newlines after restoring; doing it before is
    // strictly safer — a fence whose body contains a blank run keeps it.)
    const collapsed = prose.replace(/\n{3,}/g, '\n\n');
    const body = restoreCode(collapsed, protectedSource.stash).trim();
    const title = restoreCode(front.title, protectedSource.stash);
    const description =
      front.description === null ? null : restoreCode(front.description, protectedSource.stash);

    // A page whose body trims to nothing is still a SUCCESS with its title and
    // description: that is a real (if thin) page, and §3 decides what to do
    // with a thin one. Only an unreadable page is `ok: false`.
    const header = description === null ? title : `${title}\n${description}`;
    const text = body ? `${header}\n\n${body}` : header;

    return { ok: true, title, description, text };
  } catch (caught) {
    return fail(`extraction failed: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}
