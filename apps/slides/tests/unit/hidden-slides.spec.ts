/**
 * Hidden slides are hidden in every view a non-editor sees (#436).
 *
 * One rule (`@classmoji/services/slides/hidden`) runs over three shapes: the
 * browser DOM (view, presenter, follow, speaker view), cheerio on the server
 * (the payloads and the `/content/...` document non-editors are sent) and
 * deck.json (the thumbnail). Every case below goes through all three, so they
 * cannot drift apart.
 *
 * Runs in the Playwright runner WITHOUT a browser — jsdom stands in for it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import {
  domSlideTree,
  hiddenSlideLayout,
  remapRevealHash,
  removeHiddenSlides,
  toFullIndices,
  toVisibleIndices,
  withoutHiddenSlides,
  type SlideIndices,
} from '@classmoji/services/slides/hidden';
import {
  parseDeckHtml,
  stripHiddenSlidesFromHtml,
  type DeckJson,
} from '@classmoji/services/slides';
import { firstSlideOnly } from '../../app/routes/$slideId_.thumbnail-source/route.tsx';
import {
  deckDocumentDecision,
  deckDocumentOf,
  deckFolderOfDocument,
} from '../../app/utils/slideDocumentAccess.ts';

/** A slide is its id; a stack is the list of its children's ids. */
type Outline = Array<string | string[]>;

function outlineOf(slides: Element): Outline {
  return Array.from(slides.children).map(section => {
    const children = Array.from(section.children).filter(c => c.tagName === 'SECTION');
    const id = section.getAttribute('data-cm-id') ?? '?';
    return children.length ? children.map(c => c.getAttribute('data-cm-id') ?? '?') : id;
  });
}

function outlineOfDeck(deck: DeckJson): Outline {
  return deck.slides.map(s => (s.children?.length ? s.children.map(c => c.id) : s.id));
}

function document(slides: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><title>Deck</title></head>
<body>
  <div class="reveal" data-theme="white">
    <div class="slides">${slides}</div>
  </div>
  <script>Reveal.initialize({ hash: true });</script>
</body>
</html>`;
}

function viaDom(slides: string): Outline {
  const dom = new JSDOM(`<div class="slides">${slides}</div>`);
  const container = dom.window.document.querySelector('.slides') as Element;
  removeHiddenSlides(container, domSlideTree);
  return outlineOf(container);
}

function viaServer(slides: string): Outline {
  const stripped = stripHiddenSlidesFromHtml(document(slides));
  const dom = new JSDOM(stripped);
  return outlineOf(dom.window.document.querySelector('.slides') as Element);
}

function viaDeckJson(slides: string): Outline {
  return outlineOfDeck(withoutHiddenSlides(parseDeckHtml(document(slides)).deck));
}

const CASES: Array<{ name: string; slides: string; visible: Outline }> = [
  {
    name: 'a hidden horizontal slide goes, its neighbours stay',
    slides: `
<section data-cm-id="aaaaaaaa"><h1>A</h1></section>
<section data-cm-id="bbbbbbbb" data-hidden="true"><h1>B</h1></section>
<section data-cm-id="cccccccc"><h1>C</h1></section>`,
    visible: ['aaaaaaaa', 'cccccccc'],
  },
  {
    name: 'a hidden child of a stack goes, its visible sibling stays',
    slides: `
<section data-cm-id="ssssssss">
  <section data-cm-id="s1111111"><p>one</p></section>
  <section data-cm-id="s2222222" data-hidden="true"><p>two</p></section>
</section>`,
    visible: [['s1111111']],
  },
  {
    name: 'a hidden outer section takes its whole stack',
    slides: `
<section data-cm-id="ssssssss" data-hidden="true">
  <section data-cm-id="s1111111"><p>one</p></section>
  <section data-cm-id="s2222222"><p>two</p></section>
</section>
<section data-cm-id="aaaaaaaa"><h1>A</h1></section>`,
    visible: ['aaaaaaaa'],
  },
  {
    name: 'a stack whose children are all hidden goes',
    slides: `
<section data-cm-id="aaaaaaaa"><h1>A</h1></section>
<section data-cm-id="ssssssss">
  <section data-cm-id="s1111111" data-hidden="true"><p>one</p></section>
  <section data-cm-id="s2222222" data-hidden="true"><p>two</p></section>
</section>`,
    visible: ['aaaaaaaa'],
  },
  {
    name: 'a stack left with only a comment goes — no blank slide',
    slides: `
<section data-cm-id="ssssssss">
  <!-- week 3 extras -->
  <section data-cm-id="s1111111" data-hidden="true"><p>one</p></section>
</section>
<section data-cm-id="aaaaaaaa"><h1>A</h1></section>`,
    visible: ['aaaaaaaa'],
  },
  {
    name: 'nothing hidden: every slide stays, an empty authored one included',
    slides: `
<section data-cm-id="aaaaaaaa"><h1>A</h1></section>
<section data-cm-id="eeeeeeee"></section>
<section data-cm-id="ssssssss"><section data-cm-id="s1111111"><p>one</p></section></section>`,
    visible: ['aaaaaaaa', 'eeeeeeee', ['s1111111']],
  },
];

test.describe('the hidden-slide rule, in every shape', () => {
  for (const { name, slides, visible } of CASES) {
    test(name, () => {
      expect(viaDom(slides), 'browser DOM').toEqual(visible);
      expect(viaServer(slides), 'server html').toEqual(visible);
      expect(viaDeckJson(slides), 'deck.json').toEqual(visible);
    });
  }

  test('a non-editor payload keeps the document around the slides', () => {
    const stripped = stripHiddenSlidesFromHtml(document(CASES[0].slides));
    expect(stripped).not.toContain('<h1>B</h1>');
    expect(stripped).toContain('<title>Deck</title>');
    expect(stripped).toContain('Reveal.initialize');
  });
});

/** Every Reveal position under `.slides`, keyed by the section's data-cm-id. */
function positionsById(slides: Element): Map<string, SlideIndices> {
  const out = new Map<string, SlideIndices>();
  Array.from(slides.children).forEach((top, h) => {
    const children = Array.from(top.children).filter(c => c.tagName === 'SECTION');
    if (children.length === 0) out.set(top.getAttribute('data-cm-id') ?? '?', { h, v: 0 });
    children.forEach((child, v) => out.set(child.getAttribute('data-cm-id') ?? '?', { h, v }));
  });
  return out;
}

test.describe('the same slide across an edit/view switch', () => {
  for (const { name, slides } of CASES) {
    test(name, () => {
      const editor = new JSDOM(`<div class="slides">${slides}</div>`).window.document.querySelector(
        '.slides'
      ) as Element;
      const layout = hiddenSlideLayout(editor, domSlideTree);
      const viewer = editor.cloneNode(true) as Element;
      removeHiddenSlides(viewer, domSlideTree);
      const inEditor = positionsById(editor);
      const inViewer = positionsById(viewer);
      const viewerPositions = [...inViewer.values()];

      for (const [id, full] of inEditor) {
        const visible = toVisibleIndices(layout, full);
        const survivor = inViewer.get(id);
        if (survivor) {
          // A visible slide keeps its place both ways.
          expect(visible, `${id} edit → view`).toEqual(survivor);
          expect(toFullIndices(layout, visible), `${id} view → edit`).toEqual(full);
        } else if (viewerPositions.length > 0) {
          // A hidden one lands on a slide the viewer actually has.
          expect(viewerPositions, `${id} lands on a visible slide`).toContainEqual(visible);
        }
      }
    });
  }

  test('rewrites the hash only when the numbering differs', () => {
    const editor = new JSDOM(
      `<div class="slides">${CASES[0].slides}</div>`
    ).window.document.querySelector('.slides') as Element;
    const layout = hiddenSlideLayout(editor, domSlideTree);
    // A, [B hidden], C: the editor's #/2 is the viewer's #/1.
    expect(remapRevealHash('#/2', layout, 'visible')).toBe('#/1');
    expect(remapRevealHash('#/1', layout, 'full')).toBe('#/2');
    expect(remapRevealHash('#/0', layout, 'visible')).toBeNull();
    // Standing on the hidden slide B lands on C, the one after it — which the
    // viewer already numbers 1, so the hash is left alone.
    expect(remapRevealHash('#/1', layout, 'visible')).toBeNull();
  });
});

test.describe('the thumbnail', () => {
  test('photographs the first VISIBLE slide', () => {
    const deck = {
      version: 1,
      slides: [
        { id: 'h', hidden: true, html: '<h1>retired</h1>' },
        { id: 's', html: '', children: [{ id: 's1', hidden: true, html: '<h1>gone</h1>' }] },
        {
          id: 't',
          html: '',
          children: [
            { id: 't1', hidden: true, html: '<h1>gone too</h1>' },
            { id: 't2', html: '<h1>first visible</h1>' },
            { id: 't3', html: '<h1>later</h1>' },
          ],
        },
      ],
    } as unknown as DeckJson;

    const trimmed = firstSlideOnly(deck);
    expect(trimmed.slides).toHaveLength(1);
    expect(trimmed.slides[0].id).toBe('t');
    expect(trimmed.slides[0].children?.map(c => c.id)).toEqual(['t2']);
  });
});

test.describe('the stored document through /content/...', () => {
  const PATH = 'slides/week-1/index.html';

  test('only a deck index.html is a deck document', () => {
    expect(deckFolderOfDocument(PATH)).toBe('slides/week-1');
    expect(deckFolderOfDocument('slides/week-1/hero.png')).toBeNull();
    expect(deckFolderOfDocument('slides/week-1/index.html.bak')).toBeNull();
    expect(deckFolderOfDocument('/index.html')).toBeNull();
  });

  const EDITOR = { canEdit: true, canViewSpeakerNotes: true };
  const STUDENT = { canEdit: false, canViewSpeakerNotes: false };
  const STUDENT_WITH_NOTES = { canEdit: false, canViewSpeakerNotes: true };
  const refuse = async (): Promise<never> => {
    throw new Response('Forbidden', { status: 403 });
  };

  test('deck.json is the other deck document; assets are neither', () => {
    expect(deckDocumentOf(PATH)).toEqual({ folder: 'slides/week-1', kind: 'index' });
    expect(deckDocumentOf('slides/week-1/deck.json')).toEqual({
      folder: 'slides/week-1',
      kind: 'deck-json',
    });
    expect(deckDocumentOf('slides/week-1/hero.png')).toBeNull();
    expect(deckFolderOfDocument('slides/week-1/deck.json')).toBeNull();
  });

  test('an asset passes without a lookup', async () => {
    let looked = false;
    const decision = await deckDocumentDecision({
      path: 'slides/week-1/hero.png',
      findDecks: async () => {
        looked = true;
        return [];
      },
      rightsFor: async () => EDITOR,
    });
    expect(decision).toEqual({ outcome: 'pass' });
    expect(looked).toBe(false);
  });

  test('an editor of the deck gets it whole', async () => {
    const asked: string[] = [];
    const decision = await deckDocumentDecision({
      path: PATH,
      findDecks: async folder => {
        asked.push(folder);
        return [{ id: 'deck-1' }];
      },
      rightsFor: async () => EDITOR,
    });
    expect(decision).toEqual({ outcome: 'serve', rights: EDITOR });
    expect(asked).toEqual(['slides/week-1']);
  });

  test('a viewer gets the flags its deck row gives it', async () => {
    for (const given of [STUDENT, STUDENT_WITH_NOTES]) {
      const decision = await deckDocumentDecision({
        path: PATH,
        findDecks: async () => [{ id: 'deck-1' }],
        rightsFor: async () => given,
      });
      expect(decision).toEqual({ outcome: 'serve', rights: given });
    }
  });

  test('a deck no row admits the caller to (a draft, to a student) is refused', async () => {
    const decision = await deckDocumentDecision({
      path: PATH,
      findDecks: async () => [{ id: 'draft' }],
      rightsFor: refuse,
    });
    expect(decision).toEqual({ outcome: 'refuse' });
  });

  test('a second deck row that admits the caller still wins, flag by flag', async () => {
    const decision = await deckDocumentDecision({
      path: PATH,
      findDecks: async () => [{ id: 'draft-elsewhere' }, { id: 'published' }, { id: 'notes' }],
      rightsFor: async deck => {
        if (deck.id === 'draft-elsewhere') return refuse();
        return deck.id === 'notes' ? STUDENT_WITH_NOTES : STUDENT;
      },
    });
    expect(decision).toEqual({ outcome: 'serve', rights: STUDENT_WITH_NOTES });
  });

  test('an index.html no deck claims is served as a viewer sees it', async () => {
    const decision = await deckDocumentDecision({
      path: PATH,
      findDecks: async () => [],
      rightsFor: async () => EDITOR,
    });
    expect(decision).toEqual({ outcome: 'serve', rights: STUDENT });
  });

  test('deck.json goes to editors only', async () => {
    const path = 'slides/week-1/deck.json';
    const forRights = (rights: typeof EDITOR) =>
      deckDocumentDecision({
        path,
        findDecks: async () => [{ id: 'd' }],
        rightsFor: async () => rights,
      });
    expect(await forRights(EDITOR)).toEqual({ outcome: 'serve', rights: EDITOR });
    expect(await forRights(STUDENT_WITH_NOTES)).toEqual({ outcome: 'refuse' });
    expect(
      await deckDocumentDecision({ path, findDecks: async () => [], rightsFor: async () => EDITOR })
    ).toEqual({ outcome: 'refuse' });
  });
});

test.describe('every surface goes through the one rule', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../app/${rel}`, import.meta.url)), 'utf8');

  for (const file of [
    'components/RevealSlides.tsx',
    'components/RevealPresenter.tsx',
    'components/SpeakerView.tsx',
  ]) {
    test(`${file} uses removeHiddenSlides, not its own filter`, () => {
      const source = read(file);
      expect(source).toContain('removeHiddenSlides(');
      expect(source).not.toMatch(/section\[data-hidden/);
    });
  }

  for (const file of [
    'routes/$slideId/route.tsx',
    'routes/$slideId_.follow/route.tsx',
    'routes/$slideId_.speaker/route.tsx',
  ]) {
    test(`${file} strips hidden slides for non-editors`, () => {
      expect(read(file)).toMatch(
        /canEdit[\s\S]{0,80}stripHiddenSlidesFromHtml\(|deckHtmlForViewer\(slideContent, \{ canEdit, canViewSpeakerNotes \}\)/
      );
    });
  }

  for (const file of ['routes/$slideId/route.tsx', 'routes/$slideId_.follow/route.tsx']) {
    test(`${file} strips speaker notes through the shared helper`, () => {
      const source = read(file);
      expect(source).toContain('deckHtmlForViewer(slideContent, { canEdit, canViewSpeakerNotes })');
      expect(source).not.toMatch(/<aside\\s\+class/);
    });
  }

  test('the viewer carries the hash across the rule before dropping hidden slides', () => {
    const source = read('components/RevealSlides.tsx');
    const carry = source.indexOf('carryHashAcrossModes(container, isEditing);');
    expect(carry).toBeGreaterThan(-1);
    expect(carry).toBeLessThan(
      source.indexOf('if (!isEditing) removeHiddenSlides(container, domSlideTree);')
    );
  });

  test('the content proxy filters a deck document by the same rule', () => {
    const source = read('routes/content.$org.$repo.$/route.tsx');
    expect(source).toContain('deckDocumentDecision(');
    expect(source).toContain("if (deckDecision.outcome === 'refuse') throw forbidden();");
    expect(source).toContain('deckHtmlForViewer(text, deckDecision.rights)');
    // Decided before the read, so a refused path and a missing one match.
    expect(source.indexOf('deckDocumentDecision(')).toBeLessThan(
      source.indexOf('fetchProxyText(matched')
    );
  });
});
