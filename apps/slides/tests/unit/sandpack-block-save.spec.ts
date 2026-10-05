/**
 * Saving a deck carries every Sandpack block through untouched.
 *
 * The editor's getCurrentContent (RevealSlides) and the diff-at-save snapshot
 * (deckOpsDiff, both sides) run ONE cleanup, cleanupEditorContainer. For
 * Sandpack it strips what the live editor added (the React mount, stray text
 * typed through contenteditable) and nothing else: every attribute on the
 * embed and its files script survives, whether the editor knows it or not.
 * `data-visible-files` and `data-show-line-numbers` were dropped in prod by a
 * rebuild that re-emitted a fixed attribute list.
 *
 * "Byte-identical" here means: parse → clean → serialize equals parse →
 * serialize. Every DOM re-quotes `data-visible-files='[...]'` the same way, so
 * the hand-written source string is not the reference.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { extractDeckSnapshot } from '../../app/utils/deckOpsDiff.ts';
import { cleanupEditorContainer } from '../../app/utils/editorCleanup.ts';
import { escapeScriptPayload } from '../../app/utils/sandpackBlocks.ts';

const parse = (html: string): Document => new JSDOM(html).window.document;

/** Files as an author (or the MCP) stores them: path → contents. */
const FILES: Record<string, string> = {
  '/App.js':
    "export default function App() {\n  return <div dangerouslySetInnerHTML={{ __html: '<script>alert(1)</script>' }} />;\n}",
  '/index.html':
    '<!DOCTYPE html>\n<html><body><div id="root"></div><script src="index.js"></script></body></html>',
  '/package.json': '{"dependencies":{"lodash":"4.17.21"},"main":"/index.js"}',
  // Text that looks like markup the cleanup touches, inside the payload.
  '/notes.md': '<pre><code class="hljs">x &lt; y</code></pre> <div class="sandpack-mount"></div>',
};

/** Stored JSON: `</script>` escaped as `<\/script>` so the HTML parser keeps the payload whole. */
const STORED_JSON = escapeScriptPayload(JSON.stringify(FILES));

const EMBED = `<div class="sandpack-embed" data-template="react" data-visible-files='["/App.js"]' data-show-line-numbers="false" data-editor-width="60" data-future-option="kept">
      <script type="application/json" data-sandpack-files>${STORED_JSON}</script>
    </div>`;

const BLOCK = `<div class="sl-block" data-block-type="sandpack" style="position: absolute; left: 40px; top: 120px; width: 880px; height: 420px;">
  <div class="sl-block-content">
    ${EMBED}
  </div>
</div>`;

function deck(sectionHtml: string): string {
  return `<!DOCTYPE html><html><head></head><body><div class="reveal" data-theme="white" data-code-theme="github"><div class="slides">
<section data-cm-id="sand0001">${sectionHtml}</section>
</div></div></body></html>`;
}

const DECK = deck(`<h2>Playground</h2>${BLOCK}`);

/** The section's inner html as the DOM serializes the stored deck, with no cleanup. */
function storedSectionHtml(html = DECK): string {
  return parse(html).querySelector('section')!.innerHTML;
}

function filesOf(html: string): Record<string, string> {
  const script = parse(`<div>${html}</div>`).querySelector('script[data-sandpack-files]');
  return JSON.parse(script?.textContent ?? '{}');
}

/** What SandpackRenderer puts inside an embed while the editor is open. */
function addLiveMount(doc: Document, embed: Element): void {
  const mount = doc.createElement('div');
  mount.className = 'sandpack-mount';
  mount.innerHTML =
    '<div class="sp-wrapper"><pre><code class="hljs"><span>rendered</span></code></pre><iframe src="about:blank"></iframe></div>';
  embed.appendChild(mount);
}

/** The deck as the live editor holds it: React mount inside, text typed around it. */
function liveEditorDeck(html = DECK): Document {
  const doc = parse(html);
  const embed = doc.querySelector('.sandpack-embed')!;
  addLiveMount(doc, embed);
  embed.setAttribute('contenteditable', 'false'); // BlockHandles, while editing code
  embed.appendChild(doc.createTextNode('typed into the embed'));
  doc.querySelector('.sl-block-content')?.appendChild(doc.createTextNode('typed beside it'));
  return doc;
}

function cleaned(doc: Document): Element {
  const slides = doc.querySelector('.slides')!;
  cleanupEditorContainer(slides);
  return slides;
}

const attrs = (el: Element) => Array.from(el.attributes).map(a => [a.name, a.value]);

test.describe('diff-at-save snapshot (deckOpsDiff)', () => {
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

test.describe('cleanupEditorContainer (editor save and both diff sides)', () => {
  test('the live mount, typed text and contenteditable go; the block comes back byte-identical', () => {
    expect(cleaned(liveEditorDeck()).querySelector('section')!.innerHTML).toBe(storedSectionHtml());
  });

  test('ordering: pre-code flattening and contenteditable stripping do not reach into the payload', () => {
    const doc = liveEditorDeck(
      deck(
        `<pre><code class="hljs"><span class="hljs-keyword">let</span> a &lt; b</code></pre>${BLOCK}`
      )
    );
    const slides = cleaned(doc);
    // A real code block outside Sandpack is flattened as before …
    expect(slides.querySelector('section > pre')!.outerHTML).toBe(
      '<pre><code>let a &lt; b</code></pre>'
    );
    // … the embed loses the runtime contenteditable but nothing else …
    const embed = slides.querySelector('.sandpack-embed')!;
    expect(attrs(embed)).toEqual(attrs(parse(DECK).querySelector('.sandpack-embed')!));
    // … and markup-looking text inside the payload is untouched.
    expect(filesOf(slides.innerHTML)).toEqual(FILES);
    expect(slides.innerHTML).toContain(STORED_JSON);
  });

  test('cleaning is idempotent', () => {
    const slides = cleaned(liveEditorDeck());
    const once = slides.innerHTML;
    cleanupEditorContainer(slides);
    expect(slides.innerHTML).toBe(once);
  });

  test('a block edited in the editor (one file changed) keeps every attribute', () => {
    const doc = liveEditorDeck();
    // What the live editor's write-back leaves in the script: re-serialized
    // JSON with a raw `</script>` (JSON.stringify does not escape it).
    const edited = { ...FILES, '/App.js': 'export default () => <p>edited</p>;' };
    doc.querySelector('script[data-sandpack-files]')!.textContent = JSON.stringify(edited, null, 2);

    const slides = cleaned(doc);
    const saved = parse(`<div>${slides.innerHTML}</div>`); // through a re-parse, as the save posts it
    const embed = saved.querySelector('.sandpack-embed')!;
    expect(attrs(embed)).toEqual(attrs(parse(DECK).querySelector('.sandpack-embed')!));
    expect(embed.querySelector('.sandpack-mount')).toBeNull();
    // The only raw `</script>` left is the payload's own closing tag.
    expect(slides.innerHTML.match(/<\/script/gi)).toHaveLength(1);
    expect(JSON.parse(embed.querySelector('script[data-sandpack-files]')!.textContent!)).toEqual(
      edited
    );
  });

  test('a files script nested inside a wrapper is kept and lifted to the embed', () => {
    const doc = parse(
      deck(
        `<div class="sl-block" data-block-type="sandpack"><div class="sl-block-content"><div class="sandpack-embed" data-template="react" data-visible-files='["/App.js"]'><div><script type="application/json" data-sandpack-files>{"/App.js":"x"}</script></div><div class="sandpack-mount"><iframe></iframe></div></div></div></div>`
      )
    );
    const slides = cleaned(doc);
    expect(slides.querySelector('.sl-block-content')!.innerHTML).toBe(
      '<div class="sandpack-embed" data-template="react" data-visible-files="[&quot;/App.js&quot;]"><script type="application/json" data-sandpack-files="">{"/App.js":"x"}</script></div>'
    );
    // … and survives the next load + save.
    const again = cleaned(parse(deck(slides.querySelector('section')!.innerHTML)));
    expect(again.querySelector('.sl-block')).not.toBeNull();
    expect(filesOf(again.innerHTML)).toEqual({ '/App.js': 'x' });
  });

  test('a block missing its files payload is dropped, as before', () => {
    const doc = parse(
      deck(
        '<div class="sl-block" data-block-type="sandpack"><div class="sl-block-content"><div class="sandpack-embed"></div></div></div><p>kept</p>'
      )
    );
    expect(cleaned(doc).querySelector('section')!.innerHTML).toBe('<p>kept</p>');
  });

  test('a bare embed (no sl-block) loses its live mount and comes back byte-identical', () => {
    const bare = deck(`<h2>Bare</h2>\n${EMBED}\n`);
    const doc = parse(bare);
    addLiveMount(doc, doc.querySelector('.sandpack-embed')!);
    expect(cleaned(doc).querySelector('section')!.innerHTML).toBe(storedSectionHtml(bare));
    // No spurious update: editor output and stored deck snapshot the same.
    const posted = extractDeckSnapshot(
      `<div class="slides">${doc.querySelector('.slides')!.innerHTML}</div>`,
      parse
    )!;
    expect(posted.sections[0].html).toBe(extractDeckSnapshot(bare, parse)!.sections[0].html);
  });

  test('a no-break space beside the embed is content, not formatting', () => {
    const doc = parse(DECK);
    doc.querySelector('.sl-block-content')!.appendChild(doc.createTextNode(' '));
    expect(cleaned(doc).querySelector('.sl-block-content')!.textContent).not.toContain(' ');
  });
});

test.describe('the files payload escape', () => {
  test('every way HTML ends a script is escaped', () => {
    expect(escapeScriptPayload('a</script>b')).toBe('a<\\/script>b');
    expect(escapeScriptPayload('a</script >b')).toBe('a<\\/script >b');
    expect(escapeScriptPayload('a</script\t>b')).toBe('a<\\/script\t>b');
    expect(escapeScriptPayload('a</SCRIPT/>b')).toBe('a<\\/SCRIPT/>b');
    expect(escapeScriptPayload('a</scripts>b')).toBe('a</scripts>b');
  });

  test('escaping is idempotent: stored payloads keep their bytes', () => {
    const once = escapeScriptPayload('x</script >y</script>');
    expect(escapeScriptPayload(once)).toBe(once);
    expect(escapeScriptPayload(STORED_JSON)).toBe(STORED_JSON);
  });

  test('a payload with `</script >` survives save and reload', () => {
    const doc = parse(DECK);
    const files = { '/index.html': '<script src="a.js"></script >' };
    doc.querySelector('script[data-sandpack-files]')!.textContent = JSON.stringify(files);
    const slides = cleaned(doc);
    expect(filesOf(slides.querySelector('section')!.innerHTML)).toEqual(files);
  });
});

test.describe('the two save paths agree', () => {
  test('editor-cleaned html snapshots to the stored block (no phantom update op)', () => {
    const slides = cleaned(liveEditorDeck());
    const posted = `<div class="slides" data-theme="white" data-code-theme="github">${slides.innerHTML}</div>`;
    const curr = extractDeckSnapshot(posted, parse)!;
    const base = extractDeckSnapshot(DECK, parse)!;
    expect(curr.sections[0].html).toBe(base.sections[0].html);
  });
});
