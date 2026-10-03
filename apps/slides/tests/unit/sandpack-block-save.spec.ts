/**
 * Saving a deck carries every Sandpack block through untouched.
 *
 * Both save-time cleaners — the editor's getCurrentContent (RevealSlides) and
 * the diff-at-save snapshot (deckOpsDiff cleanupContainer) — strip what the
 * live editor added to a Sandpack block (the React mount, stray text typed
 * through contenteditable) and nothing else. Every attribute on the embed and
 * its files script survives, whether the editor knows it or not:
 * `data-visible-files` and `data-show-line-numbers` were dropped in prod by a
 * rebuild that re-emitted a fixed attribute list.
 *
 * "Byte-identical" here means: parse → clean → serialize equals parse →
 * serialize. Every DOM re-quotes `data-visible-files='[...]'` the same way, so
 * the hand-written source string is not the reference.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { extractDeckSnapshot } from '../../app/utils/deckOpsDiff.ts';
import { cleanSandpackBlocks } from '../../app/utils/sandpackBlocks.ts';

const parse = (html: string): Document => new JSDOM(html).window.document;

/** Files as an author (or the MCP) stores them: path → contents. */
const FILES: Record<string, string> = {
  '/App.js':
    "export default function App() {\n  return <div dangerouslySetInnerHTML={{ __html: '<script>alert(1)</script>' }} />;\n}",
  '/index.html':
    '<!DOCTYPE html>\n<html><body><div id="root"></div><script src="index.js"></script></body></html>',
  '/package.json': '{"dependencies":{"lodash":"4.17.21"},"main":"/index.js"}',
};

/** Stored JSON: `</script>` escaped as `<\/script>` so the HTML parser keeps the payload whole. */
const STORED_JSON = JSON.stringify(FILES).replace(/<\/script>/gi, '<\\/script>');

const BLOCK = `<div class="sl-block" data-block-type="sandpack" style="position: absolute; left: 40px; top: 120px; width: 880px; height: 420px;">
  <div class="sl-block-content">
    <div class="sandpack-embed" data-template="react" data-visible-files='["/App.js"]' data-show-line-numbers="false" data-editor-width="60" data-future-option="kept">
      <script type="application/json" data-sandpack-files>${STORED_JSON}</script>
    </div>
  </div>
</div>`;

const DECK = `<!DOCTYPE html><html><head></head><body><div class="reveal" data-theme="white" data-code-theme="github"><div class="slides">
<section data-cm-id="sand0001"><h2>Playground</h2>${BLOCK}</section>
</div></div></body></html>`;

/** The section's inner html as the DOM serializes the stored deck, with no cleanup. */
function storedSectionHtml(): string {
  return parse(DECK).querySelector('section')!.innerHTML;
}

function filesOf(html: string): Record<string, string> {
  const doc = parse(`<div>${html}</div>`);
  const script = doc.querySelector('script[data-sandpack-files]');
  return JSON.parse(script?.textContent ?? '{}');
}

test.describe('diff-at-save snapshot (deckOpsDiff cleanupContainer)', () => {
  test('an untouched Sandpack block is byte-identical after cleanup', () => {
    const snapshot = extractDeckSnapshot(DECK, parse);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sections[0].html).toBe(storedSectionHtml());
  });

  test('data-visible-files, data-show-line-numbers and unknown attributes survive', () => {
    const html = extractDeckSnapshot(DECK, parse)!.sections[0].html!;
    const embed = parse(`<div>${html}</div>`).querySelector('.sandpack-embed')!;
    expect(embed.getAttribute('data-visible-files')).toBe('["/App.js"]');
    expect(embed.getAttribute('data-show-line-numbers')).toBe('false');
    expect(embed.getAttribute('data-editor-width')).toBe('60');
    expect(embed.getAttribute('data-future-option')).toBe('kept');
    // No defaults invented for attributes the author left out.
    expect(embed.hasAttribute('data-theme')).toBe(false);
    expect(embed.hasAttribute('data-layout')).toBe(false);
  });

  test('the files payload keeps `<\\/script>` escaped and parses back to the stored files', () => {
    const html = extractDeckSnapshot(DECK, parse)!.sections[0].html!;
    expect(html).toContain(STORED_JSON);
    expect(filesOf(html)).toEqual(FILES);
  });
});

/**
 * The deck as the live editor holds it: SandpackRenderer's React mount inside
 * the embed, and text typed into the block through contenteditable.
 */
function liveEditorDeck(): Document {
  const doc = parse(DECK);
  const embed = doc.querySelector('.sandpack-embed')!;
  const mount = doc.createElement('div');
  mount.className = 'sandpack-mount';
  mount.innerHTML =
    '<div class="sp-wrapper"><pre><code>rendered editor</code></pre><iframe></iframe></div>';
  embed.appendChild(mount);
  embed.appendChild(doc.createTextNode('typed into the embed'));
  doc.querySelector('.sl-block-content')!.appendChild(doc.createTextNode('typed beside it'));
  return doc;
}

test.describe('editor save (RevealSlides getCurrentContent)', () => {
  test('getCurrentContent runs the shared cleaner, not its own rebuild', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../app/components/RevealSlides.tsx', import.meta.url)),
      'utf8'
    );
    expect(source).toContain('cleanSandpackBlocks(slidesClone)');
    expect(source).not.toContain('contentDiv.innerHTML');
  });

  test('the live mount and typed text go; the stored block comes back byte-identical', () => {
    const doc = liveEditorDeck();
    cleanSandpackBlocks(doc.querySelector('.slides')!);
    expect(doc.querySelector('section')!.innerHTML).toBe(storedSectionHtml());
  });

  test('cleaning is idempotent (both diff sides run it)', () => {
    const doc = liveEditorDeck();
    const slides = doc.querySelector('.slides')!;
    cleanSandpackBlocks(slides);
    const once = slides.innerHTML;
    cleanSandpackBlocks(slides);
    expect(slides.innerHTML).toBe(once);
  });

  test('a block edited in the editor (one file changed) keeps every attribute', () => {
    const doc = liveEditorDeck();
    // What the live editor's write-back leaves in the script: re-serialized
    // JSON with a raw `</script>` (JSON.stringify does not escape it).
    const edited = { ...FILES, '/App.js': 'export default () => <p>edited</p>;' };
    doc.querySelector('script[data-sandpack-files]')!.textContent = JSON.stringify(edited, null, 2);

    const slides = doc.querySelector('.slides')!;
    cleanSandpackBlocks(slides);

    // Through a re-parse, as the save posts it.
    const saved = parse(`<div>${slides.innerHTML}</div>`);
    const embed = saved.querySelector('.sandpack-embed')!;
    const original = parse(DECK).querySelector('.sandpack-embed')!;
    const attrs = (el: Element) => Array.from(el.attributes).map(a => [a.name, a.value]);
    expect(attrs(embed)).toEqual(attrs(original));
    expect(embed.querySelector('.sandpack-mount')).toBeNull();
    // The only raw `</script>` left is the payload's own closing tag.
    expect(slides.innerHTML.match(/<\/script>/gi)).toHaveLength(1);
    expect(JSON.parse(embed.querySelector('script[data-sandpack-files]')!.textContent!)).toEqual(
      edited
    );
  });

  test('a block missing its files payload is dropped, as before', () => {
    const doc = parse(
      '<div class="slides"><section><div class="sl-block" data-block-type="sandpack"><div class="sl-block-content"><div class="sandpack-embed"></div></div></div><p>kept</p></section></div>'
    );
    cleanSandpackBlocks(doc.querySelector('.slides')!);
    expect(doc.querySelector('section')!.innerHTML).toBe('<p>kept</p>');
  });
});

test.describe('the two save paths agree', () => {
  test('editor-cleaned html snapshots to the stored block (no phantom update op)', () => {
    const doc = liveEditorDeck();
    const slides = doc.querySelector('.slides')!;
    cleanSandpackBlocks(slides);
    const posted = `<div class="slides" data-theme="white" data-code-theme="github">${slides.innerHTML}</div>`;
    const curr = extractDeckSnapshot(posted, parse)!;
    const base = extractDeckSnapshot(DECK, parse)!;
    expect(curr.sections[0].html).toBe(base.sections[0].html);
  });
});
