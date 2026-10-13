import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { codeBlockOptions } from '@blocknote/code-block';

/**
 * Syntax colouring for the class site's code and terminal blocks.
 *
 * In the app both are coloured in the browser: code blocks by
 * `@blocknote/code-block`'s `syntaxHighlighter` (Shiki, `github-light` and
 * `github-dark`, every token a `<span class="shiki">` carrying both colours as
 * `--shiki-light`/`--shiki-dark`, which BlockNote's stylesheet resolves to the
 * dark one because a code block is dark in both colour schemes), terminals by
 * TerminalBlock.tsx (Shiki, `bash` in `one-dark-pro`, its `<pre>` background
 * dropped). A class site ships no JavaScript, so this does the same work at
 * render time and the markup arrives coloured.
 *
 * ## Same Shiki as the app
 *
 * The app runs two different Shikis, and so does this.
 *
 * Code blocks: `@blocknote/code-block` does not export its highlighter, and a
 * bare `import('@shikijs/core')` here resolves to another version (the one
 * TerminalBlock.tsx gets). So those modules are resolved from
 * `@blocknote/code-block`'s own location: the core, engine, precompiled
 * grammars and themes its bundle loads, at its versions, with the same
 * `createBundledHighlighter`, the same JavaScript regex engine and the same
 * language keys (every id and alias in `codeBlockOptions`, each loading the
 * grammar named by its id, exactly as `shiki.bundle.ts` maps them). Node
 * imports them at run time; no bundler sees these paths.
 *
 * Terminals: TerminalBlock.tsx's own imports (`@shikijs/core`,
 * `@shikijs/langs/bash`, `@shikijs/themes/one-dark-pro`), resolved from this
 * app as they are there. Not the code block's `bash`: its precompiled grammar
 * colours a terminal differently (a `#` comment after a blank line came out
 * as a command).
 *
 * ## Cost
 *
 * Each highlighter is created once per process, on the first page that needs
 * it. A code block grammar loads the first time a page uses its language and
 * stays loaded. A page without code or terminal blocks never touches any of
 * this.
 *
 * Tokenizing is what costs, about 4 ms per 1,000 characters of TypeScript,
 * and a class site is public and served from one shared CPU. So it is
 * bounded (`LIMITS`): a block over `blockChars` is never tokenized, a render
 * stops tokenizing once it has spent `budgetMs` (the rest of its blocks are
 * plain, and the next request finds more in the cache), and the markup cache
 * holds `cacheChars`, no entry over `entryChars`. Plain is always the markup
 * the site rendered before colouring existed.
 */

/** The part of a Shiki highlighter this module uses. */
type ShikiToken = { content: string; offset: number; htmlStyle?: Record<string, string> | string };
type ShikiTransformer = { pre?: (node: { properties: Record<string, unknown> }) => void };
export type ShikiLike = {
  loadLanguage(...langs: string[]): Promise<void>;
  getLoadedLanguages(): string[];
  codeToTokens(code: string, options: Record<string, unknown>): { tokens: ShikiToken[][] };
  codeToHtml(
    code: string,
    options: Record<string, unknown> & { transformers?: ShikiTransformer[] }
  ): string;
};

/**
 * What the static block renders ask for, per render. `codeBlock`/`terminal`
 * return the slot to render in place of the code (`null`: draw it plain), and
 * `fill` puts the coloured markup into the finished page's slots.
 */
export type SiteCodeHighlighter = {
  /**
   * A code block's text as token spans, the way the app's editor decorates it.
   * `language` is the block's prop as stored: anything but a string is plain,
   * as it is in the app (Shiki gets no language to load).
   */
  codeBlock(code: string, language: unknown): string | null;
  /** A terminal's commands as Shiki's `<pre>`, the way TerminalBlock.tsx draws it. */
  terminal(code: string): string | null;
  /** The page's HTML with every slot this render handed out replaced by its markup. */
  fill(html: string): string;
};

/** Languages that mean "no colouring" (BlockNote's `PLAIN_TEXT_LANGUAGES`). */
const PLAIN_TEXT_LANGUAGES = ['text', 'none', 'plaintext', 'txt'];

/** The code block's themes, light first as BlockNote picks them. */
const CODE_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/** The terminal's grammar and theme (TerminalBlock.tsx). */
const TERMINAL_LANGUAGE = 'bash';
const TERMINAL_THEME = 'one-dark-pro';

/** How much highlighting one block, one render and the cache may cost. */
export type HighlightLimits = {
  /** A block with more characters of code than this is drawn plain. */
  blockChars: number;
  /** A render that has spent this long tokenizing draws its remaining blocks plain. */
  budgetMs: number;
  /** The markup cache's size, in characters of keys and markup. */
  cacheChars: number;
  /** The largest single cache entry; anything larger is made but not kept. */
  entryChars: number;
  /** The clock the budget is measured on. */
  now: () => number;
};

/**
 * 50,000 characters of TypeScript tokenize in about 0.2 s and make about
 * 0.62M characters of markup, so the largest block allowed still fits one
 * cache entry. A page of 95 code blocks (80,000 characters) needs about
 * 0.3 s: its first render colours most of it, the second the rest, and after
 * that it is all cache.
 */
const LIMITS: HighlightLimits = {
  blockChars: 50_000,
  budgetMs: 300,
  cacheChars: 8_000_000,
  entryChars: 1_000_000,
  now: () => performance.now(),
};

/**
 * A process highlighter, created on first use. A failed creation is
 * forgotten, so the next page tries again, and logged once: a class site
 * with plain code and nothing in the logs is how a broken install would
 * otherwise look.
 */
function once<T>(name: string, create: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  let warned = false;
  return () => {
    promise ??= create().catch(error => {
      promise = null;
      if (!warned) {
        warned = true;
        console.warn(`[site] ${name} highlighter unavailable; code renders plain`, error);
      }
      throw error;
    });
    return promise;
  };
}

/**
 * Language key → grammar module, as `@blocknote/code-block`'s bundle maps
 * them: every id and alias of `codeBlockOptions.supportedLanguages` except
 * plain text, each to the precompiled grammar named by its id. A key is
 * matched exactly (case and all), as Shiki looks it up there.
 */
const GRAMMARS: Record<string, string> = Object.create(null);
for (const [id, { aliases = [] }] of Object.entries(
  codeBlockOptions.supportedLanguages as Record<string, { aliases?: readonly string[] }>
)) {
  if (id === 'text') continue;
  for (const key of [id, ...aliases]) GRAMMARS[key] ??= id;
}

/** Import a module the way `@blocknote/code-block` would resolve it. */
function importFromCodeBlock<T>(specifier: string): Promise<T> {
  const fromCodeBlock = createRequire(
    createRequire(import.meta.url).resolve('@blocknote/code-block')
  );
  return import(/* @vite-ignore */ pathToFileURL(fromCodeBlock.resolve(specifier)).href);
}

type ShikiModule = { default: unknown };

/** The code blocks' highlighter, as `@blocknote/code-block`'s `syntaxHighlighter` creates it. */
const codeBlockShiki = once('code block', async (): Promise<ShikiLike> => {
  const [{ createBundledHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
    importFromCodeBlock<{
      createBundledHighlighter: (
        options: Record<string, unknown>
      ) => (options: Record<string, unknown>) => Promise<ShikiLike>;
    }>('@shikijs/core'),
    importFromCodeBlock<{ createJavaScriptRegexEngine: () => unknown }>(
      '@shikijs/engine-javascript'
    ),
  ]);
  const langs: Record<string, () => Promise<ShikiModule>> = Object.create(null);
  for (const [key, id] of Object.entries(GRAMMARS)) {
    langs[key] = () => importFromCodeBlock(`@shikijs/langs-precompiled/${id}`);
  }
  const themes: Record<string, () => Promise<ShikiModule>> = Object.create(null);
  for (const theme of [CODE_THEMES.dark, CODE_THEMES.light]) {
    themes[theme] = () => importFromCodeBlock(`@shikijs/themes/${theme}`);
  }
  const create = createBundledHighlighter({
    langs,
    themes,
    engine: () => createJavaScriptRegexEngine(),
  });
  return create({ themes: [CODE_THEMES.dark, CODE_THEMES.light], langs: [] });
});

/** The terminals' highlighter, as TerminalBlock.tsx creates it. */
const terminalShiki = once('terminal', async (): Promise<ShikiLike> => {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, bash, oneDarkPro] =
    await Promise.all([
      import('@shikijs/core'),
      import('@shikijs/engine-javascript'),
      import('@shikijs/langs/bash'),
      import('@shikijs/themes/one-dark-pro'),
    ]);
  const shiki = await createHighlighterCore({
    langs: [bash.default],
    themes: [oneDarkPro.default],
    engine: createJavaScriptRegexEngine(),
  });
  return shiki as unknown as ShikiLike;
});

/** Where a render's highlighters come from: the process's, or a test's. */
export type SiteShikiSources = {
  codeBlocks: () => Promise<ShikiLike>;
  terminals: () => Promise<ShikiLike>;
};

const PROCESS_SHIKI: SiteShikiSources = { codeBlocks: codeBlockShiki, terminals: terminalShiki };

/**
 * Each language key's load, once per highlighter. A grammar that fails to
 * load stays plain from then on, like BlockNote's `unsupportedLanguages`, and
 * is logged that once. (Only keys the bundle has get here, so a failure is a
 * broken install, not an author's typo.)
 */
const grammarLoads = new WeakMap<ShikiLike, Map<string, Promise<void>>>();

function loadGrammar(shiki: ShikiLike, key: string): Promise<void> {
  let loads = grammarLoads.get(shiki);
  if (!loads) grammarLoads.set(shiki, (loads = new Map()));
  let load = loads.get(key);
  if (!load) {
    load = shiki.loadLanguage(key).catch(error => {
      console.warn(`[site] grammar "${key}" did not load; its code renders plain`, error);
    });
    loads.set(key, load);
  }
  return load;
}

/** Would the app try to colour this language at all? */
function isColourable(language: string): boolean {
  return Boolean(language) && !PLAIN_TEXT_LANGUAGES.includes(language) && language in GRAMMARS;
}

/* ------------------------------------------------------------------ *
 * Markup
 * ------------------------------------------------------------------ */

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeAttribute = (value: string): string =>
  escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A token's style as prosemirror-highlight writes it onto its decoration. */
function tokenStyle(style: ShikiToken['htmlStyle']): string {
  if (!style) return '';
  if (typeof style === 'string') return style;
  return Object.entries(style)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}

/**
 * The code with every token wrapped in the span the app's editor decorates it
 * with, and every character between tokens (newlines) kept as it is: the
 * markup's text is the code, byte for byte. Tokens are placed by their offset
 * into the code rather than by counting lines, and anything that does not line
 * up gives `null` (plain) rather than code that reads differently.
 */
function tokenSpans(code: string, tokens: ShikiToken[][]): string | null {
  let html = '';
  let at = 0;
  for (const line of tokens) {
    for (const token of line) {
      if (!token.content) continue;
      if (
        token.offset < at ||
        code.slice(token.offset, token.offset + token.content.length) !== token.content
      ) {
        return null;
      }
      html += escapeText(code.slice(at, token.offset));
      html += `<span class="shiki" style="${escapeAttribute(tokenStyle(token.htmlStyle))}">${escapeText(token.content)}</span>`;
      at = token.offset + token.content.length;
    }
  }
  return html + escapeText(code.slice(at));
}

/** A code block's coloured markup, or `null` (plain). Never throws. */
function codeBlockMarkup(shiki: ShikiLike, code: string, language: string): string | null {
  if (!code || !isColourable(language) || !shiki.getLoadedLanguages().includes(language)) {
    return null;
  }
  try {
    const { tokens } = shiki.codeToTokens(code, {
      lang: language,
      themes: CODE_THEMES,
      defaultColor: false,
    });
    return tokenSpans(code, tokens);
  } catch {
    return null;
  }
}

/** A terminal's coloured `<pre>`, or `null` (plain). Never throws. */
function terminalMarkup(shiki: ShikiLike, code: string): string | null {
  if (!code || !shiki.getLoadedLanguages().includes(TERMINAL_LANGUAGE)) return null;
  try {
    return shiki.codeToHtml(code, {
      lang: TERMINAL_LANGUAGE,
      theme: TERMINAL_THEME,
      // TerminalBlock.tsx removes Shiki's background so the terminal's own
      // shows. Here it comes off the <pre>'s style alone, never out of the
      // code's text.
      transformers: [
        {
          pre(node) {
            const style = node.properties.style;
            if (typeof style === 'string') {
              node.properties.style = style.replace(/background-color:[^;]+;?/g, '');
            }
          },
        },
      ],
    });
  } catch {
    return null;
  }
}

/**
 * Markup already made, per highlighter: key (a code block's language and
 * code, a terminal's code) → markup, least recently used first.
 *
 * A member's render is never shared, so without this every visit to a page
 * of code tokenizes all of it again. The same code makes the same markup, so
 * a repeat costs a lookup.
 */
type MarkupCache = { entries: Map<string, string>; chars: number };
const markupCaches = new WeakMap<ShikiLike, MarkupCache>();

function markupCache(shiki: ShikiLike): MarkupCache {
  let cache = markupCaches.get(shiki);
  if (!cache) markupCaches.set(shiki, (cache = { entries: new Map(), chars: 0 }));
  return cache;
}

function cacheGet(shiki: ShikiLike, key: string): string | undefined {
  const { entries } = markupCache(shiki);
  const hit = entries.get(key);
  if (hit !== undefined) {
    entries.delete(key);
    entries.set(key, hit);
  }
  return hit;
}

/** Keep `markup` unless it is over `entryChars`, evicting the least recently used. */
function cacheSet(shiki: ShikiLike, key: string, markup: string, limits: HighlightLimits): void {
  const size = key.length + markup.length;
  if (size > limits.entryChars) return;
  const cache = markupCache(shiki);
  cache.entries.set(key, markup);
  cache.chars += size;
  for (const [oldest, old] of cache.entries) {
    if (cache.chars <= limits.cacheChars) break;
    cache.entries.delete(oldest);
    cache.chars -= oldest.length + old.length;
  }
}

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

/**
 * Private-use characters around a slot's name. Only a slot name ever matters:
 * it carries the render's random nonce, which no document can contain.
 */
const SLOT_OPEN = '\uE000';
const SLOT_CLOSE = '\uE001';

/**
 * One render's highlighter. The block renders put a SLOT (a short text
 * placeholder) where the coloured code goes, and `fill` swaps each slot for
 * its markup in the finished page.
 *
 * Why not render the markup into the blocks directly: a page of code is tens
 * of thousands of token spans, and every one of them would then be parsed and
 * re-serialized by JSDOM twice (the block render, then `addHeadingAnchors`).
 * On a 95-block page that was most of a second per request, inside the
 * render lock. The markup is built here, from escaped text and the themes'
 * colours, and needs no second pass.
 *
 * A slot is text inside the block's own element, so it reaches the page HTML
 * as text. Its name holds a random nonce made for this render, and `fill`
 * replaces only names with that nonce: author content cannot name a slot.
 */
export function siteCodeHighlighter(
  codeBlocks: ShikiLike | null,
  terminals: ShikiLike | null,
  limits: HighlightLimits = LIMITS
): SiteCodeHighlighter {
  const nonce = randomUUID();
  const markups: string[] = [];
  let spentMs = 0;

  /** The markup for `key`: cached, or made if the block and the budget allow. */
  const markupFor = (shiki: ShikiLike, key: string, code: string, make: () => string | null) => {
    if (!code || code.length > limits.blockChars) return null;
    const hit = cacheGet(shiki, key);
    if (hit !== undefined) return hit;
    if (spentMs >= limits.budgetMs) return null;
    const started = limits.now();
    const markup = make();
    spentMs += limits.now() - started;
    if (markup !== null) cacheSet(shiki, key, markup, limits);
    return markup;
  };

  const slot = (markup: string | null): string | null => {
    if (markup === null) return null;
    markups.push(markup);
    return `${SLOT_OPEN}${nonce}:${markups.length - 1}${SLOT_CLOSE}`;
  };
  const slots = new RegExp(`${SLOT_OPEN}${nonce}:(\\d+)${SLOT_CLOSE}`, 'g');

  return {
    codeBlock: (code, language) =>
      codeBlocks && typeof language === 'string'
        ? slot(
            markupFor(codeBlocks, `${language}\0${code}`, code, () =>
              codeBlockMarkup(codeBlocks, code, language)
            )
          )
        : null,
    terminal: code =>
      terminals
        ? slot(markupFor(terminals, code, code, () => terminalMarkup(terminals, code)))
        : null,
    fill: html =>
      markups.length === 0 ? html : html.replace(slots, (_, index) => markups[Number(index)] ?? ''),
  };
}

/* ------------------------------------------------------------------ *
 * Per render
 * ------------------------------------------------------------------ */

type BlockLike = { type?: unknown; props?: unknown; children?: unknown };

/**
 * What a document's blocks need: its code blocks' language keys, and whether
 * any terminal has code. A code block with no `language` prop gets the schema
 * default, as the serializer fills it in before the block renders; one whose
 * `language` is not a string needs nothing (`codeBlock` draws it plain).
 */
export function codeInDocument(blocks: unknown): { languages: Set<string>; terminals: boolean } {
  const found = new Set<string>();
  let terminals = false;
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const block of list as BlockLike[]) {
      if (!block || typeof block !== 'object') continue;
      const props = (block.props && typeof block.props === 'object' ? block.props : {}) as Record<
        string,
        unknown
      >;
      if (block.type === 'codeBlock') {
        const language = 'language' in props ? props.language : codeBlockOptions.defaultLanguage;
        if (typeof language === 'string' && isColourable(language)) found.add(language);
      } else if (block.type === 'terminal' && props.code) {
        terminals = true;
      }
      walk(block.children);
    }
  };
  walk(blocks);
  return { languages: found, terminals };
}

/**
 * Load what one document needs and return its block renders' highlighter, or
 * `null` when it has nothing to colour. A highlighter that cannot be had
 * leaves its blocks plain, exactly as before, and never fails the page. Runs
 * before the render, which is synchronous.
 *
 * `sources` is for tests (renderSitePage passes its `codeHighlighters`
 * through); the site always uses the process's highlighters.
 */
export async function prepareSiteCodeHighlighter(
  blocks: unknown,
  sources: SiteShikiSources = PROCESS_SHIKI
): Promise<SiteCodeHighlighter | null> {
  const { languages, terminals } = codeInDocument(blocks);
  if (languages.size === 0 && !terminals) return null;
  const [codeBlocks, terminal] = await Promise.all([
    languages.size === 0
      ? null
      : sources
          .codeBlocks()
          .then(async shiki => {
            await Promise.all([...languages].map(language => loadGrammar(shiki, language)));
            return shiki;
          })
          .catch(() => null),
    terminals ? sources.terminals().catch(() => null) : null,
  ]);
  return siteCodeHighlighter(codeBlocks, terminal);
}
