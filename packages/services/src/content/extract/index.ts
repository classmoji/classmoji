/**
 * `@classmoji/services/content/extract` — course content → plain text.
 *
 * One function, three sources: a BlockNote `content.json`, a legacy page
 * `index.html`, and a generated slide-deck `index.html`. Its output feeds the
 * embedding and snippet columns of the content index (plan §5, P2-4 onward),
 * and is what `content_get` serves; no caller ever gets the raw fetched bytes.
 * It is never the source of truth for anything (D4).
 *
 * NOT exported from the services barrel (`packages/services/src/index.ts`), and
 * that is load-bearing: this module parses HTML with cheerio, and
 * `packages/services/src/slides/index.ts:1-9` records that cheerio must not load
 * through the root barrel, because the webapp, mcp, hook-station and tasks all
 * import that barrel at startup. Own subpath, own blast radius —
 * `import { extractText } from '@classmoji/services/content/extract'`.
 *
 * Pure: cheerio and a JSON walk. No barrel import, no `@classmoji/database`, no
 * `apps/*`. Bytes in, text out — so it can sit at the bottom of the package
 * graph and be moved by changing a path.
 */

import { extractBlockNoteText, type ContentReference } from './blocknote.ts';
import { extractDeckHtmlText, extractPageHtmlText } from './html.ts';

export type { ContentReference } from './blocknote.ts';
export { KNOWN_BLOCK_TYPES } from './blocknote.ts';

export type ExtractSource =
  /**
   * `pages/<slug>/content.json`. Both stored shapes are accepted — the
   * `{ blocks, coverImage? }` wrapper and the bare blocks array — plus the raw
   * file contents as a string, which is what the delivery layer hands back.
   */
  | { kind: 'blocknote'; json: string | unknown[] | { blocks?: unknown } | null | undefined }
  /** `pages/<slug>/index.html` — legacy, inert once a page is migrated. */
  | { kind: 'page-html'; html: string | null | undefined }
  /** `slides/<slug>/index.html` — generated from `deck.json` on every save. */
  | { kind: 'deck-html'; html: string | null | undefined };

export interface ExtractedText {
  /**
   * False when the source could not be understood.
   *
   * `text` is '' in that case, and an empty string that means "unreadable" must
   * not be indexed or served as though it meant "this document is empty" — the
   * caller is expected to branch on this rather than on `text.length`.
   */
  ok: boolean;
  /** Newline-joined plain text, ready to embed. Never null; '' when there is nothing. */
  text: string;
  /**
   * Deck speaker notes, kept SEPARATE and NEVER part of `text`.
   *
   * Notes are instructor-facing: follow mode strips them before broadcasting to
   * students (`apps/slides/app/routes/$slideId_.follow/route.tsx:106`) and
   * `Slide.show_speaker_notes` defaults false
   * (`packages/database/schema.prisma:1235`). They are detached from the DOM
   * before anything else runs, so no branch — the unparseable-deck fallback
   * included — can put them in `text`. v1 does not embed this field; it exists
   * so a later staff-scoped index is one call site rather than a
   * re-architecture. Always '' for the two page kinds.
   */
  notes: string;
  /**
   * Documents this one POINTS AT: `pageLink` targets and `navGrid` entries.
   *
   * Targets only, never their labels. A stored label is a copy of another
   * document's title, and this document's draft state says nothing about that
   * one's — see the reference rule in `blocknote.ts`. A caller that has a
   * viewer context can resolve and authorize these; `text` stays free of them.
   * Always empty for the two HTML kinds, which carry no structured references.
   */
  references: ContentReference[];
  /** Why `ok` is false. Absent when `ok`. */
  error?: string;
}

export interface ExtractOptions {
  /**
   * The document's title, from the DB row. Prepended to `text` on success.
   *
   * It is not reliably in the content: legacy page bodies have their first
   * `<h1>` stripped by the renderer because the DB holds the title
   * (`apps/pages/app/utils/content.server.ts:136-149`), a BlockNote document
   * has no title block at all, and a deck's title lives in `<head>`, which the
   * extractor never reads.
   */
  title?: string;
}

/**
 * Extract plain text from one piece of course content.
 *
 * Never throws. An indexer runs inside a save path; it must not be able to fail
 * the save. Failures come back as `ok: false` with a reason, not as exceptions
 * and not as a silently empty success.
 */
export function extractText(source: ExtractSource, opts: ExtractOptions = {}): ExtractedText {
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';

  let body = '';
  let notes = '';
  let references: ContentReference[] = [];
  let error: string | undefined;

  try {
    switch (source.kind) {
      case 'blocknote': {
        const page = extractBlockNoteText(source.json);
        body = page.text;
        references = page.references;
        error = page.error;
        break;
      }
      case 'page-html':
        body = extractPageHtmlText(source.html);
        break;
      case 'deck-html': {
        const deck = extractDeckHtmlText(source.html);
        body = deck.text;
        notes = deck.notes;
        error = deck.error;
        break;
      }
    }
  } catch (caught) {
    return {
      ok: false,
      text: '',
      notes: '',
      references: [],
      error: `extraction failed: ${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }

  // A source that is simply absent is an empty document, not a failure.
  if (error) return { ok: false, text: '', notes, references: [], error };

  return { ok: true, text: [title, body].filter(Boolean).join('\n'), notes, references };
}
