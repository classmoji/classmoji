/**
 * When an island-mounted reader is READY: the viewer is on screen (the
 * reader's `onReady`), code highlighting has settled, fonts have loaded, and
 * two animation frames have passed. Only then does the document raise
 * `data-render-ready` (`islandDom.ts`) — what the MCP's page render waits for
 * before it measures and screenshots.
 *
 * Highlighting is the slow part: BlockNote's Shiki highlighter loads lazily
 * (its own chunk, then one grammar chunk per language) and repaints a code
 * block only when its grammar is in. A block is waited for when it has code
 * and its language is one Shiki is asked to paint: the page code block asks
 * for the canonical id (`codeBlockHighlightLanguage`, page-schema), and plain
 * text, `plain`, `''` and names the bundle lacks are never asked. The
 * languages are also asked of the highlighter itself (`loadLanguage`), so a
 * mismatch is not waited on. Every wait is bounded: a highlighter that never
 * loads delays a render by at most `highlightMs`, and one that is not there
 * at all (BlockNote moved it) by a short grace, never the full wait.
 */
import { codeBlockOptions } from '@blocknote/code-block';
import { BLOCKNOTE_SHIKI_HIGHLIGHTER, codeBlockHighlightLanguage } from '@classmoji/page-schema';

/** A block with no `language` prop is the code block's default (page-schema builds it from these options). */
export const DEFAULT_CODE_LANGUAGE = codeBlockOptions.defaultLanguage ?? 'text';

/** How long after the view is on screen the highlighter may still be missing. */
const HIGHLIGHTER_GRACE_MS = 500;

interface HighlighterLike {
  loadLanguage(language: string): Promise<unknown>;
}

type LooseBlock = {
  id?: unknown;
  type?: unknown;
  props?: { language?: unknown } | null;
  children?: unknown;
};

/**
 * `block id → the language Shiki is asked to paint` for every code block in
 * the document (any depth); `text` where it is never asked.
 */
export function codeBlockLanguages(blocks: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const block of list as LooseBlock[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'codeBlock' && typeof block.id === 'string') {
        const language = block.props?.language;
        out.set(
          block.id,
          codeBlockHighlightLanguage(
            typeof language === 'string' ? language : DEFAULT_CODE_LANGUAGE
          )
        );
      }
      walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** `promise`'s value, or `fallback` once `ms` have passed. Never rejects. */
async function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a code block's element is painted: Shiki's token spans carry `--shiki-*` colours. */
function painted(element: Element): boolean {
  return element.querySelector('[style*="--shiki"]') !== null;
}

/**
 * Resolves `'settled'` once every code block Shiki will paint is painted
 * (`'none'` when there is none to wait for), `'unavailable'` when BlockNote's
 * highlighter is not where it is expected, or `'timeout'` after `timeoutMs`.
 */
export async function highlightSettled(
  root: ParentNode,
  blocks: unknown,
  timeoutMs: number
): Promise<'none' | 'settled' | 'timeout' | 'unavailable'> {
  const deadline = Date.now() + timeoutMs;
  const languages = codeBlockLanguages(blocks);
  const candidates: Array<{ element: Element; language: string }> = [];
  root.querySelectorAll('.bn-block-outer[data-id]').forEach(outer => {
    const id = outer.getAttribute('data-id');
    const language = id ? languages.get(id) : undefined;
    if (!language || language === 'text') return;
    const content = outer.querySelector(':scope > .bn-block > .bn-block-content');
    if (!content || content.getAttribute('data-content-type') !== 'codeBlock') return;
    if (!(content.querySelector('pre')?.textContent ?? '').trim()) return;
    candidates.push({ element: content, language });
  });
  if (candidates.length === 0) return 'none';

  // The highlighter BlockNote created on its first highlight pass, which ran
  // when the view mounted: missing after a short grace means it is not coming.
  const holder = globalThis as { [BLOCKNOTE_SHIKI_HIGHLIGHTER]?: Promise<HighlighterLike> };
  const grace = Math.min(deadline, Date.now() + HIGHLIGHTER_GRACE_MS);
  while (!holder[BLOCKNOTE_SHIKI_HIGHLIGHTER]) {
    if (Date.now() >= grace) return 'unavailable';
    await sleep(25);
  }
  const highlighter = await bounded<HighlighterLike | null>(
    holder[BLOCKNOTE_SHIKI_HIGHLIGHTER],
    Math.max(0, deadline - Date.now()),
    null
  );
  if (!highlighter) return 'timeout';

  // The languages the highlighter loads (already loaded ones resolve at
  // once). Shiki throws synchronously for one it lacks, hence the promise.
  const loadable = new Set<string>();
  const loads = Promise.all(
    [...new Set(candidates.map(c => c.language))].map(language =>
      Promise.resolve()
        .then(() => highlighter.loadLanguage(language))
        .then(
          () => loadable.add(language),
          () => undefined
        )
    )
  );
  if (
    !(await bounded(
      loads.then(() => true),
      Math.max(0, deadline - Date.now()),
      false
    ))
  ) {
    return 'timeout';
  }

  const waiting = candidates.filter(c => loadable.has(c.language));
  while (!waiting.every(c => painted(c.element))) {
    if (Date.now() >= deadline) return 'timeout';
    await frame();
  }
  return 'settled';
}

/** Resolves once the document's fonts have loaded (`true`), or `false` after `timeoutMs`. */
export function fontsSettled(timeoutMs: number, doc: Document = document): Promise<boolean> {
  const ready = doc.fonts?.ready;
  if (!ready) return Promise.resolve(true);
  return bounded(
    ready.then(() => true),
    timeoutMs,
    false
  );
}

export interface ReadinessLimits {
  highlightMs: number;
  fontsMs: number;
}

/** Bounded well under the MCP driver's own 20 s wait for the marker. */
export const DEFAULT_READINESS_LIMITS: ReadinessLimits = { highlightMs: 6000, fontsMs: 4000 };

/**
 * Everything after the viewer is mounted: highlighting and fonts (in
 * parallel), then two frames. Resolves with how it ended: `'settled'`, or the
 * parts that timed out (`'highlight-timeout'`, `'fonts-timeout'`, both).
 */
export async function readerSettled(
  root: ParentNode,
  blocks: unknown,
  limits: ReadinessLimits = DEFAULT_READINESS_LIMITS
): Promise<string> {
  const [highlight, fonts] = await Promise.all([
    highlightSettled(root, blocks, limits.highlightMs),
    fontsSettled(limits.fontsMs),
  ]);
  await frame();
  await frame();
  const late = [
    ...(highlight === 'timeout' ? ['highlight-timeout'] : []),
    ...(highlight === 'unavailable' ? ['highlighter-unavailable'] : []),
    ...(fonts ? [] : ['fonts-timeout']),
  ];
  return late.length > 0 ? late.join(' ') : 'settled';
}
