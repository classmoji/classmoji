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
  removeHiddenSlides,
  withoutHiddenSlides,
} from '@classmoji/services/slides/hidden';
import {
  parseDeckHtml,
  stripHiddenSlidesFromHtml,
  type DeckJson,
} from '@classmoji/services/slides';
import { firstSlideOnly } from '../../app/routes/$slideId_.thumbnail-source/route.tsx';
import { deckDocumentRights, deckFolderOfDocument } from '../../app/utils/slideDocumentAccess.ts';

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

  test('an editor of the deck gets it whole', async () => {
    const asked: string[] = [];
    const rights = await deckDocumentRights({
      path: PATH,
      classroomIds: ['c1'],
      findDecks: async (_ids, folder) => {
        asked.push(folder);
        return [{ id: 'deck-1' }];
      },
      rightsFor: async () => EDITOR,
    });
    expect(rights).toEqual(EDITOR);
    expect(asked).toEqual(['slides/week-1']);
  });

  test('a viewer gets the flags its deck row gives it', async () => {
    for (const given of [STUDENT, STUDENT_WITH_NOTES]) {
      const rights = await deckDocumentRights({
        path: PATH,
        classroomIds: ['c1'],
        findDecks: async () => [{ id: 'deck-1' }],
        rightsFor: async () => given,
      });
      expect(rights).toEqual(given);
    }
  });

  test('any doubt grants nothing: refused check, unknown folder, no classroom', async () => {
    const refused = await deckDocumentRights({
      path: PATH,
      classroomIds: ['c1'],
      findDecks: async () => [{ id: 'deck-1' }],
      rightsFor: async () => {
        throw new Response('Forbidden', { status: 403 });
      },
    });
    const unknown = await deckDocumentRights({
      path: PATH,
      classroomIds: ['c1'],
      findDecks: async () => [],
      rightsFor: async () => EDITOR,
    });
    const noClassroom = await deckDocumentRights({
      path: PATH,
      classroomIds: [],
      findDecks: async () => [{ id: 'deck-1' }],
      rightsFor: async () => EDITOR,
    });
    expect([refused, unknown, noClassroom]).toEqual([STUDENT, STUDENT, STUDENT]);
  });

  test('a second deck row that grants a flag still wins', async () => {
    const rights = await deckDocumentRights({
      path: PATH,
      classroomIds: ['c1', 'c2'],
      findDecks: async () => [{ id: 'other-classroom' }, { id: 'mine' }],
      rightsFor: async deck => (deck.id === 'mine' ? EDITOR : STUDENT),
    });
    expect(rights).toEqual(EDITOR);
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

  test('the content proxy filters a deck document by the same rule', () => {
    const source = read('routes/content.$org.$repo.$/route.tsx');
    expect(source).toContain('deckDocumentRights(');
    expect(source).toContain('deckHtmlForViewer(text, rights)');
  });
});
