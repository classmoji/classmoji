/**
 * The page content check (page_content_apply, page_preview_accept,
 * page_create): the document a write would leave must
 * open in BlockNote under its STOCK rules (`validatePageBlocks`), or nothing
 * is written. A page that does not would show readers nothing at all.
 *
 * Only blocks the call changed or added are judged: a block whose own
 * content (everything but its children) is as it was before the ops is left
 * alone, so a page that already holds a bad run elsewhere does not block an
 * unrelated edit (the cleanup script fixes those).
 *
 * The validator builds an unmounted BlockNote editor: loaded on first use,
 * like collab/pageSchema.ts, so tools that never write pages never load it.
 */

import type { PageContentProblem } from '@classmoji/page-schema/server';
import { ToolError } from '../mcp/errors.ts';

type Validate = (blocks: unknown) => PageContentProblem[];

let loading: Promise<Validate> | null = null;

/**
 * The validator, loaded once. A failed load is not cached (the next call
 * tries again) and is a coded error: content is never written unchecked.
 */
async function validator(): Promise<Validate> {
  loading ??= import('@classmoji/page-schema/server').then(module => module.validatePageBlocks);
  try {
    return await loading;
  } catch (error) {
    loading = null;
    console.error('[mcp] The page content check could not be loaded:', error);
    throw new ToolError(
      'internal',
      'Nothing was written: the page content check is unavailable right now. Retry shortly.',
      'CONTENT_CHECK_UNAVAILABLE'
    );
  }
}

/** Every problem `blocks` has under BlockNote's stock rules (`[]`: it opens). */
export async function pageContentProblems(blocks: unknown[]): Promise<PageContentProblem[]> {
  return (await validator())(blocks);
}

/** A block's own content: everything but its children, as stable text. */
function ownContent(block: unknown): string {
  if (!block || typeof block !== 'object') return JSON.stringify(block) ?? '';
  const { children: _children, ...own } = block as Record<string, unknown>;
  return JSON.stringify(own);
}

function indexById(blocks: unknown[], out = new Map<string, string>()): Map<string, string> {
  for (const block of blocks) {
    const id = (block as { id?: unknown } | null)?.id;
    if (typeof id === 'string') out.set(id, ownContent(block));
    const children = (block as { children?: unknown } | null)?.children;
    if (Array.isArray(children)) indexById(children, out);
  }
  return out;
}

function findOwn(blocks: unknown[], id: string): unknown {
  for (const block of blocks) {
    if ((block as { id?: unknown } | null)?.id === id) return block;
    const children = (block as { children?: unknown } | null)?.children;
    if (Array.isArray(children)) {
      const found = findOwn(children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** How many problems the refusal names in its message (all are in `data`). */
const MESSAGE_PROBLEMS = 5;
const DATA_PROBLEMS = 50;

function describe(problem: PageContentProblem): string {
  const where = problem.blockId ? `block '${problem.blockId}'` : 'a block';
  const what = [problem.blockType, problem.text ? `"${problem.text}"` : null]
    .filter(Boolean)
    .join(', ');
  return `${where}${what ? ` (${what})` : ''}: ${problem.problem}`;
}

/**
 * The problems `next` has that `prior` did not, limited to blocks the ops
 * changed or added; `[]` when the result may be written.
 */
export async function newContentProblems(
  prior: unknown[],
  next: unknown[]
): Promise<PageContentProblem[]> {
  const validate = await validator();
  const problems = validate(next);
  if (problems.length === 0) return [];
  const before = indexById(prior);
  let priorProblems: Set<string> | undefined;
  return problems.filter(problem => {
    if (problem.blockId) {
      const was = before.get(problem.blockId);
      return was === undefined || was !== ownContent(findOwn(next, problem.blockId));
    }
    // No block to compare by: new only if the document before did not have it.
    priorProblems ??= new Set(validate(prior).map(p => p.problem));
    return !priorProblems.has(problem.problem);
  });
}

/**
 * Converted blocks (page_create's `html`) made writable: an author cannot fix
 * a converter's output, so what would not open is cleaned rather than
 * refused. The conversion worker cleans already; this covers a worker that
 * predates it.
 */
export async function writableConvertedBlocks(blocks: unknown[]): Promise<unknown[]> {
  if ((await pageContentProblems(blocks)).length === 0) return blocks;
  const { cleanPageBlocks } = await import('@classmoji/page-schema');
  return cleanPageBlocks(blocks).blocks;
}

/** How to fix what the problems name: only the hints that apply. */
function hints(problems: PageContentProblem[]): string[] {
  const out: string[] = [];
  if (problems.some(p => p.problem.startsWith('inline code'))) {
    out.push(
      'Inline code takes no other formatting (bold, italic, underline, strike, colours) and ' +
        'cannot sit inside a link.'
    );
  }
  if (problems.some(p => p.problem === "unknown text style 'href'")) {
    out.push(
      "A link is an inline item { type: 'link', href, content: [text runs] }, never an " +
        'href text style.'
    );
  }
  return out;
}

/** INVALID_CONTENT naming the problems; `fix` says what to do next. */
export function invalidContentError(problems: PageContentProblem[], fix: string): ToolError {
  const named = problems.slice(0, MESSAGE_PROBLEMS).map(describe);
  const more = problems.length - named.length;
  return new ToolError(
    'invalid_params',
    [
      "Nothing was written: the page editor can't open this content. " +
        `${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`,
      ...hints(problems),
      fix,
    ].join(' '),
    'INVALID_CONTENT',
    { problems: problems.slice(0, DATA_PROBLEMS) }
  );
}

/**
 * Refuse (INVALID_CONTENT, nothing written) when the ops would leave content
 * BlockNote cannot open; see `newContentProblems`.
 */
export async function assertWritablePageContent(prior: unknown[], next: unknown[]): Promise<void> {
  const problems = await newContentProblems(prior, next);
  if (problems.length === 0) return;
  throw invalidContentError(problems, 'Fix the blocks named and retry.');
}
