/**
 * The deck editor's frames, under jsdom: a frame of ours is shown through the
 * editor frame route and written back as the reference the deck stores — on
 * every write path (the live deck's per-slide serialization, the git
 * editor's save and its diff), whatever Reveal's lazy loading did meanwhile.
 * Also: html blocks that are files, legacy blocks shown through the preview
 * frame, the file prompt's reference counting, the iframe panel's stored
 * source, and slide markup cleaned where the editor and viewer insert it.
 *
 * Runs in the Playwright runner without a browser.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { HTML_BLOCK_SANDBOX, htmlBlockMarkup } from '@classmoji/services/slides/runtime-attrs';
import { pageSessionMarker, sessionInertName } from '@classmoji/services/slides/safe-markup';

import {
  canonicalFrames,
  displayFrameValue,
  ownFilesRef,
  readStoredIframeSrc,
  showFrames,
  storedFrameValue,
  writeStoredIframeSrc,
  type EditorFrames,
} from '../../app/utils/editorFrames.ts';
import { sectionFromMarkup, serializeSection } from '../../app/utils/collab/bridgeDom.ts';
import {
  editorSlidesFragment,
  storedSectionsHtml,
  viewerSlidesFragment,
} from '../../app/utils/slideMarkup.ts';
import { LEGACY_SRCDOC_ATTR } from '../../app/utils/legacyHtmlBlocks.ts';
import { diffDeckSnapshots, extractDeckSnapshot } from '../../app/utils/deckOpsDiff.ts';
import {
  htmlBlockFileNamedIn,
  htmlBlockSourceOf,
  isHtmlBlockFileShared,
  orphanedHtmlBlockFiles,
  repoFileProblem,
  setHtmlBlockFile,
} from '../../app/components/blocks/slideBlocks.ts';

const jsdom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://slides.test/deck-1',
});
const doc: Document = jsdom.window.document;

const SLIDE_ID = '9b2f1c4e-0000-4000-8000-000000000001';
const CLASSROOM = '11111111-2222-3333-4444-555555555555';
const CONTENT = 'https://content.test';
const FRAMES: EditorFrames = {
  slideId: SLIDE_ID,
  deckFolder: 'slides/week-1',
  classroomId: CLASSROOM,
  repoLogin: 'cs98-org',
  repo: 'cs98-content',
  ourHosts: ['slides.test', 'app.test', '.classmoji.test'],
  contentOrigin: CONTENT,
};
const EDITOR = `/${SLIDE_ID}/frame`;
const REV = 'a'.repeat(40);
const REV2 = 'b'.repeat(40);
const BOX = { left: 10, top: 20, width: 300, height: 200 };
const marker = pageSessionMarker();

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

function holder(html: string): HTMLElement {
  const el = doc.createElement('div');
  el.innerHTML = html;
  return el;
}

/** A deck section as the editor shows it (sanitized, frames shown). */
function shown(html: string, frames: EditorFrames | null = FRAMES): HTMLElement {
  return sectionFromMarkup(doc, `<section data-cm-id="s1">${html}</section>`, {
    frames,
    contentOrigin: CONTENT,
  });
}

/** Reveal's lazy load of a slide: `data-src` → `src` + `data-lazy-loaded`. */
function revealLoads(root: Element) {
  for (const el of Array.from(root.querySelectorAll('iframe[data-src]'))) {
    el.setAttribute('src', el.getAttribute('data-src') as string);
    el.setAttribute('data-lazy-loaded', '');
    el.removeAttribute('data-src');
  }
}

test.describe('one frame value', () => {
  test('ours is shown through the editor route and stored relative to the deck', () => {
    const cases: Array<[string, string, string]> = [
      [
        'games/snake/index.html',
        `${EDITOR}/slides/week-1/games/snake/index.html`,
        'games/snake/index.html',
      ],
      [
        '../../games/sketchkit/draw.html?deck=x&f=y',
        `${EDITOR}/games/sketchkit/draw.html?deck=x&f=y`,
        '../../games/sketchkit/draw.html?deck=x&f=y',
      ],
      [
        '/content/cs98-org/cs98-content/slides/week-1/games/a/index.html',
        `${EDITOR}/slides/week-1/games/a/index.html`,
        'games/a/index.html',
      ],
      [
        'https://cs98-org.github.io/cs98-content/games/b/index.html#top',
        `${EDITOR}/games/b/index.html#top`,
        '../../games/b/index.html#top',
      ],
      [
        `${CONTENT}/c/${CLASSROOM}/files/R1/w.1.2.sig/slides/week-1/games/c/index.html?q=1`,
        `${EDITOR}/slides/week-1/games/c/index.html?q=1`,
        'games/c/index.html?q=1',
      ],
    ];
    for (const [stored, display, back] of cases) {
      expect(displayFrameValue(stored, FRAMES)).toEqual({ kind: 'set', value: display });
      expect(storedFrameValue(display, FRAMES)).toBe(back);
      // The display form is a fixed point.
      expect(displayFrameValue(display, FRAMES)).toEqual({ kind: 'keep' });
    }
  });

  test('external frames are kept; app pages, scripts and other classrooms are inert', () => {
    for (const v of ['https://www.youtube.com/embed/x', 'about:blank', '']) {
      expect(displayFrameValue(v, FRAMES)).toEqual({ kind: 'keep' });
    }
    for (const v of [
      'https://slides.test/other-deck',
      'https://www.classmoji.test/',
      'javascript:alert(1)',
      `${CONTENT}/c/99999999-2222-3333-4444-555555555555/files/R/w.1.2.s/a.html`,
      '../../../outside.html',
      'deck.json',
      `/other-slide/frame/slides/week-1/x.html`,
    ]) {
      expect(displayFrameValue(v, FRAMES)).toEqual({ kind: 'inert' });
    }
  });

  test('a files URL of another classroom is not read as ours', () => {
    expect(
      ownFilesRef(`${CONTENT}/c/${CLASSROOM}/files/G/t/slides/week-1/a.html?x=1`, FRAMES)
    ).toEqual({ repoPath: 'slides/week-1/a.html', query: '?x=1' });
    expect(ownFilesRef(`${CONTENT}/c/other/files/G/t/a.html`, FRAMES)).toBeNull();
    expect(
      ownFilesRef(`https://elsewhere.test/c/${CLASSROOM}/files/G/t/a.html`, FRAMES)
    ).toBeNull();
  });
});

test.describe('display and back, through the live deck serialization', () => {
  test('an iframe, a background frame and an html block file', () => {
    const block = htmlBlockMarkup({ id: 'b1', box: BOX, src: 'blocks/ab12cd34.html', rev: REV });
    const html =
      '<iframe data-src="games/snake/index.html" sandbox="allow-scripts"></iframe>' +
      '<iframe src="https://www.youtube.com/embed/x"></iframe>' +
      block;
    const section = sectionFromMarkup(
      doc,
      `<section data-cm-id="s1" data-background-iframe="../../games/bg/index.html">${html}</section>`,
      { frames: FRAMES }
    );
    const [game, video, blockFrame] = Array.from(section.querySelectorAll('iframe'));
    expect(game.getAttribute('data-src')).toBe(`${EDITOR}/slides/week-1/games/snake/index.html`);
    expect(video.getAttribute('src')).toBe('https://www.youtube.com/embed/x');
    expect(blockFrame.getAttribute('src')).toBe(
      `${EDITOR}/slides/week-1/blocks/ab12cd34.html?cm-rev=${REV}`
    );
    expect(section.getAttribute('data-background-iframe')).toBe(`${EDITOR}/games/bg/index.html`);

    const ser = serializeSection(section, FRAMES);
    expect(ser.html).toBe(holder(html).innerHTML);
    expect(ser.attrs['data-background-iframe']).toBe('../../games/bg/index.html');
    expect(JSON.stringify(ser)).not.toContain('/frame/');
  });

  test("Reveal's lazy loading reduces to the stored value (loaded, mirrored, unloaded)", () => {
    const html = '<iframe data-src="games/snake/index.html" title="g"></iframe>';
    const stored = serializeSection(shown(html), FRAMES).html;
    expect(stored).toBe(holder(html).innerHTML);

    const loaded = shown(html);
    revealLoads(loaded);
    expect(loaded.querySelector('iframe')?.getAttribute('src')).toContain('/frame/');
    expect(serializeSection(loaded, FRAMES).html).toBe(stored);

    // Started without the lazy-load marker: src mirrors data-src.
    const mirrored = shown(html);
    const frame = mirrored.querySelector('iframe') as HTMLIFrameElement;
    frame.setAttribute('src', frame.getAttribute('data-src') as string);
    expect(serializeSection(mirrored, FRAMES).html).toBe(stored);
  });

  test('an html block file: its own src never stored, a new revision a new URL', () => {
    const block = htmlBlockMarkup({ id: 'b1', box: BOX, src: 'blocks/ab12cd34.html', rev: REV });
    const section = shown(block);
    const el = section.querySelector('.sl-block') as HTMLElement;
    setHtmlBlockFile(el, { src: 'blocks/ab12cd34.html', rev: REV2 }, FRAMES);
    expect(el.querySelector('iframe')?.getAttribute('src')).toBe(
      `${EDITOR}/slides/week-1/blocks/ab12cd34.html?cm-rev=${REV2}`
    );
    const ser = serializeSection(section, FRAMES).html ?? '';
    expect(ser).toContain(`data-cm-src="blocks/ab12cd34.html" data-cm-rev="${REV2}"`);
    expect(ser).not.toMatch(/\ssrc=|srcdoc|\/frame\//);
    expect(htmlBlockSourceOf(el)).toEqual({ kind: 'file', src: 'blocks/ab12cd34.html', rev: REV2 });
  });

  test('an html block whose sandbox would let it out shows nothing', () => {
    const block = htmlBlockMarkup({ id: 'b1', box: BOX, src: 'blocks/ab12cd34.html', rev: REV });
    const unsafe = block.replace(
      `sandbox="${HTML_BLOCK_SANDBOX}"`,
      'sandbox="allow-scripts allow-same-origin"'
    );
    const section = shown(unsafe);
    expect(section.querySelector('iframe')?.hasAttribute('src')).toBe(false);
    expect(serializeSection(section, FRAMES).html).toBe(holder(unsafe).innerHTML);
  });

  test('a frame that must not load is renamed for display and stored as authored', () => {
    const html = '<iframe src="https://app.test/admin" title="x"></iframe>';
    const section = shown(html);
    const frame = section.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.getAttribute(sessionInertName(marker, 'src'))).toBe('https://app.test/admin');
    expect(serializeSection(section, FRAMES).html).toBe(holder(html).innerHTML);
  });

  test('a legacy html block shows through the preview frame and is stored byte for byte', () => {
    const block = htmlBlockMarkup({ id: 'b1', box: BOX, source: '<p>1 &lt; 2</p>' });
    const section = shown(block);
    const frame = section.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('src')).toBe(`${CONTENT}/preview-frame`);
    expect(frame.getAttribute(LEGACY_SRCDOC_ATTR)).toContain('<p>1 &lt; 2</p>');
    expect(serializeSection(section, FRAMES).html).toBe(holder(block).innerHTML);
    // Without a frame context (local development) it is left inline.
    const local = sectionFromMarkup(doc, `<section data-cm-id="s1">${block}</section>`);
    expect(local.querySelector('iframe')?.hasAttribute('srcdoc')).toBe(true);
  });

  test('without a frame context frames are shown as stored', () => {
    const html = '<iframe data-src="games/snake/index.html"></iframe>';
    const section = shown(html, null);
    expect(section.querySelector('iframe')?.getAttribute('data-src')).toBe(
      'games/snake/index.html'
    );
    expect(serializeSection(section, null).html).toBe(holder(html).innerHTML);
  });

  test('showFrames is idempotent (a frame already shown is not touched)', () => {
    const section = shown('<iframe data-src="games/a.html"></iframe>');
    const before = section.outerHTML;
    showFrames(section, FRAMES);
    expect(section.outerHTML).toBe(before);
  });
});

test.describe("the git editor's save and its diff", () => {
  const STORED =
    '<section data-cm-id="s1"><h2>One</h2>' +
    '<iframe data-src="/content/cs98-org/cs98-content/slides/week-1/games/a/index.html"></iframe>' +
    '</section><section data-cm-id="s2"><p>Two</p></section>';

  function editorDeck(): HTMLElement {
    const slides = doc.createElement('div');
    slides.className = 'slides';
    slides.replaceChildren(editorSlidesFragment(STORED, doc, { frames: FRAMES }));
    return slides;
  }

  test('no editor URL reaches what a save posts', () => {
    const slides = editorDeck();
    expect(slides.innerHTML).toContain('/frame/');
    revealLoads(slides);
    const posted = storedSectionsHtml(slides, FRAMES);
    expect(posted).not.toContain('/frame/');
    expect(posted).toContain('games/a/index.html');
  });

  test('a deck merely viewed in the editor diffs as unchanged', () => {
    const parse = (html: string) => {
      const parsed = new jsdom.window.DOMParser().parseFromString(html, 'text/html') as Document;
      canonicalFrames(parsed.body, FRAMES);
      return parsed;
    };
    const base = extractDeckSnapshot(`<div class="slides">${STORED}</div>`, parse);
    const posted = `<div class="slides">${storedSectionsHtml(editorDeck(), FRAMES)}</div>`;
    const curr = extractDeckSnapshot(posted, parse);
    expect(base && curr && diffDeckSnapshots(base, curr)).toEqual([]);
  });
});

test.describe('html block files: the delete prompt and forks count references', () => {
  const deckWith = (...srcs: Array<string | null>) =>
    holder(
      srcs
        .map((src, i) =>
          src
            ? `<section>${htmlBlockMarkup({ id: `b${i}`, box: BOX, src, rev: REV })}</section>`
            : `<section>${htmlBlockMarkup({ id: `b${i}`, box: BOX, source: 'x' })}</section>`
        )
        .join('')
    );

  test('a removed block whose file no block names any more', () => {
    const deck = deckWith('blocks/aaaaaaaa.html', 'blocks/bbbbbbbb.html', 'blocks/bbbbbbbb.html');
    const [first, second] = Array.from(deck.querySelectorAll('section'));
    first.remove();
    second.remove();
    // The second file is still named by the third block.
    expect(orphanedHtmlBlockFiles([first, second], deck)).toEqual(['blocks/aaaaaaaa.html']);
  });

  test('a slide with several blocks, a repo file and a legacy block', () => {
    const deck = deckWith(null);
    const slide = holder(
      htmlBlockMarkup({ id: 'b1', box: BOX, src: 'blocks/cccccccc.html', rev: REV }) +
        htmlBlockMarkup({ id: 'b2', box: BOX, src: 'games/snake/index.html' }) +
        htmlBlockMarkup({ id: 'b3', box: BOX, src: 'blocks/cccccccc.html', rev: REV }) +
        htmlBlockMarkup({ id: 'b4', box: BOX, source: 'y' })
    );
    // Only `blocks/` files are asked about, each once.
    expect(orphanedHtmlBlockFiles([slide], deck)).toEqual(['blocks/cccccccc.html']);
  });

  test('a copy shares its file until its first Apply forks it', () => {
    const deck = deckWith('blocks/aaaaaaaa.html', 'blocks/aaaaaaaa.html', 'blocks/dddddddd.html');
    const [one, , three] = Array.from(deck.querySelectorAll('.sl-block'));
    expect(isHtmlBlockFileShared(one, 'blocks/aaaaaaaa.html', deck)).toBe(true);
    expect(isHtmlBlockFileShared(three, 'blocks/dddddddd.html', deck)).toBe(false);
    expect(htmlBlockFileNamedIn('blocks/dddddddd.html', deck)).toBe(true);
    expect(htmlBlockFileNamedIn('blocks/eeeeeeee.html', deck)).toBe(false);
  });

  test('a repo file path is checked against the repository', async () => {
    const listed: string[] = [];
    const list = async (folder: string) => {
      listed.push(folder);
      return { entries: [{ path: 'games/snake/index.html', type: 'file' }] };
    };
    expect(
      await repoFileProblem('../../games/snake/index.html?x=1', 'slides/week-1', list)
    ).toBeNull();
    expect(listed).toEqual(['games/snake']);
    expect(await repoFileProblem('../../games/snake/other.html', 'slides/week-1', list)).toBe(
      'Not found: ../../games/snake/other.html'
    );
    expect(await repoFileProblem('https://x.test/a.html', 'slides/week-1', list)).toMatch(
      /^This path cannot be used/
    );
    expect(await repoFileProblem('deck.json', 'slides/week-1', list)).toMatch(
      /^This path cannot be used/
    );
  });
});

test.describe('the iframe panel edits the stored source', () => {
  test('src, data-src, and data-src while Reveal has it loaded', () => {
    for (const [html, attr] of [
      ['<iframe src="games/a.html" sandbox="allow-scripts"></iframe>', 'src'],
      ['<iframe data-src="games/a.html" sandbox="allow-scripts"></iframe>', 'data-src'],
    ] as const) {
      const section = shown(html);
      const frame = section.querySelector('iframe') as HTMLIFrameElement;
      expect(readStoredIframeSrc(frame, FRAMES)).toBe('games/a.html');
      if (attr === 'data-src') revealLoads(section);
      expect(readStoredIframeSrc(frame, FRAMES)).toBe('games/a.html');

      writeStoredIframeSrc(frame, '../../games/b/index.html', FRAMES);
      expect(readStoredIframeSrc(frame, FRAMES)).toBe('../../games/b/index.html');
      // Nothing else changed: the sandbox stays, the shown value is the editor's.
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(JSON.stringify(serializeSection(section, FRAMES))).toContain(
        `data-src` === attr
          ? 'data-src=\\"../../games/b/index.html\\"'
          : 'src=\\"../../games/b/index.html\\"'
      );

      writeStoredIframeSrc(frame, 'https://www.youtube.com/embed/x', FRAMES);
      expect(readStoredIframeSrc(frame, FRAMES)).toBe('https://www.youtube.com/embed/x');
      expect(serializeSection(section, FRAMES).html).not.toContain('/frame/');
    }
  });

  test('a value that must not load is kept, inert, and stored as typed', () => {
    const section = shown('<iframe src="about:blank"></iframe>');
    const frame = section.querySelector('iframe') as HTMLIFrameElement;
    writeStoredIframeSrc(frame, 'https://app.test/x', FRAMES);
    expect(frame.hasAttribute('src')).toBe(false);
    expect(readStoredIframeSrc(frame, FRAMES)).toBe('https://app.test/x');
    expect(serializeSection(section, FRAMES).html).toBe(
      '<iframe src="https://app.test/x"></iframe>'
    );
  });

  test('new iframes and the panel share one default sandbox', () => {
    expect(source('../../app/components/SlideToolbar.tsx')).toContain(
      "iframe.setAttribute('sandbox', DEFAULT_IFRAME_SANDBOX)"
    );
    expect(source('../../app/components/properties/editors/IframeProperties.tsx')).toContain(
      "label: 'Scripts + Same Origin + Forms + Popups (default)'"
    );
  });
});

test.describe('slide markup is cleaned where it is inserted', () => {
  const HOSTILE =
    '<section><img src="x" onerror="window.__spy.push(1)"><a href="javascript:void(0)">a</a>' +
    '<script>window.__spy.push(2)</script></section>';

  test('the viewer: nothing runs, nothing to restore', () => {
    const live = new JSDOM('<!doctype html><body><div class="slides"></div></body>', {
      runScripts: 'dangerously',
    });
    const win = live.window as unknown as Window & { __spy: number[] };
    win.__spy = [];
    const slides = win.document.querySelector('.slides') as Element;
    slides.replaceChildren(viewerSlidesFragment(HOSTILE, win.document, {}));
    for (const el of Array.from(slides.querySelectorAll('*'))) {
      el.dispatchEvent(new (live.window as unknown as typeof globalThis).Event('error'));
    }
    expect(win.__spy).toEqual([]);
    expect(slides.innerHTML).not.toMatch(/onerror|javascript:|<script/);
  });

  test('the editor: shown inert, written back as authored', () => {
    const slides = doc.createElement('div');
    slides.replaceChildren(editorSlidesFragment(HOSTILE, doc, { frames: FRAMES }));
    expect(slides.querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(slides.querySelector('script')).toBeNull();
    expect(storedSectionsHtml(slides, FRAMES)).toBe(holder(HOSTILE).innerHTML);
  });

  test('every sink inserts nodes, never markup', () => {
    const slides = source('../../app/components/RevealSlides.tsx');
    expect(slides).not.toMatch(/\.innerHTML\s*=\s*htmlContent/);
    expect(slides).toContain('slidesContainer.replaceChildren(');
    // Reveal's cross-window API stays off: locked options last, guards first.
    const init = slides.slice(slides.indexOf('const deck = new Reveal('));
    expect(init.slice(0, init.indexOf('});'))).toMatch(/\.\.\.REVEAL_LOCKED_OPTIONS,\s*$/);
    const before = slides.slice(0, slides.indexOf('const deck = new Reveal('));
    expect(before).toContain('stripRevealQueryConfig();');
    expect(before).toContain('installRevealMessageGuard();');

    expect(source('../../app/components/SlideOverview/SlideThumbnail.tsx')).not.toContain(
      'dangerouslySetInnerHTML'
    );
    expect(source('../../app/components/SlideNotesPanel.tsx')).not.toMatch(/\.innerHTML\s*=/);
    expect(source('../../app/components/SlideToolbar.tsx')).not.toContain(
      'content.innerHTML = snippet.content'
    );
  });
});
