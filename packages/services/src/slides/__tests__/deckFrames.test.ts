/**
 * The deck frame passes: read-time signing (`rewriteDeckFrames`) and the
 * save-time backstop (`canonicalizeDeckFrames`).
 */

import { describe, it, expect, vi } from 'vitest';

import { extractOwnRepoPath } from '../../classmoji/contentRefs.ts';
import { HTML_BLOCK_SANDBOX } from '../deckBlocks.ts';
import {
  FRAME_MISSING_ATTR,
  canonicalizeDeckFrames,
  canonicalizeFrameMarkup,
  rewriteDeckFrames,
} from '../deckFrames.ts';
import type { DeckJson } from '../deckTypes.ts';
import type { FrameRefOptions, RepoFrameTarget } from '../frameRefs.ts';

const ORG = 'cs52-org';
const REPO = 'cs52-content';
const DECK = 'slides/week-1';
const SLIDE_ID = '9b2f1c4e-0000-4000-8000-000000000001';
const OTHER_SLIDE_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const CLASSROOM = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CONTENT = 'https://content.classmoji.io';
const BASE = `${CONTENT}/c/${CLASSROOM}/files/GRANT/week.1.2.sig/`;

function filesRef(url: string): RepoFrameTarget | null {
  if (!url.startsWith(BASE)) return null;
  const rest = url.slice(BASE.length);
  const cut = rest.search(/[?#]/);
  return {
    repoPath: decodeURIComponent(cut === -1 ? rest : rest.slice(0, cut)),
    query: cut === -1 ? '' : rest.slice(cut),
  };
}

const refs: FrameRefOptions = {
  deckFolder: DECK,
  ownRepoPath: value => extractOwnRepoPath(value, ORG, REPO),
  ourHosts: ['slides.classmoji.io', '.classmoji.io'],
  contentOrigin: CONTENT,
  slideId: SLIDE_ID,
  filesRef,
};

/** Signs everything except paths containing `missing`. */
const sign = vi.fn(async (repoPath: string, query: string) =>
  repoPath.includes('missing') ? null : `${BASE}${repoPath}${query}`
);

const rewrite = (html: string) => rewriteDeckFrames(html, { refs, sign });

const doc = (slides: string) =>
  `<!DOCTYPE html><html><head><title>x</title></head><body><div class="reveal"><div class="slides">${slides}</div></div></body></html>`;

describe('rewriteDeckFrames', () => {
  it('returns the input when there is no frame', async () => {
    const html = doc('<section><p>hi</p><img src="a.png"></section>');
    expect(await rewrite(html)).toBe(html);
  });

  it('signs a html block from data-cm-src into data-src, boxed, keeping the stored attrs', async () => {
    const out = await rewrite(
      doc(
        '<section><div class="sl-block" data-block-type="html"><div class="sl-block-content">' +
          '<iframe sandbox="allow-scripts" allow="fullscreen" data-cm-src="blocks/ab12cd34.html" data-cm-rev="r1"></iframe>' +
          '</div></div></section>'
      )
    );
    expect(out).toContain(`data-src="${BASE}slides/week-1/blocks/ab12cd34.html"`);
    expect(out).toContain('data-cm-src="blocks/ab12cd34.html"');
    expect(out).toContain('data-cm-rev="r1"');
    expect(out).toContain(`sandbox="${HTML_BLOCK_SANDBOX}"`);
    expect(out).not.toMatch(/\ssrc="/);
  });

  it('an html block loads only its file: src and srcdoc are dropped', async () => {
    const out = await rewrite(
      '<iframe data-cm-src="blocks/a.html" src="https://evil.example/" srcdoc="<b>x</b>"></iframe>'
    );
    expect(out).toBe(
      `<iframe data-cm-src="blocks/a.html" data-src="${BASE}slides/week-1/blocks/a.html" sandbox="${HTML_BLOCK_SANDBOX}"></iframe>`
    );
  });

  it('signs iframe src and data-src of ours in place, leaves external ones alone', async () => {
    const out = await rewrite(
      `<iframe src="/content/${ORG}/${REPO}/games/snake/index.html?l=2"></iframe>` +
        '<iframe data-src="games/a/i.html" sandbox="allow-scripts allow-same-origin"></iframe>' +
        '<iframe src="https://www.youtube.com/embed/x" sandbox="allow-scripts allow-same-origin"></iframe>'
    );
    expect(out).toContain(`src="${BASE}games/snake/index.html?l=2"`);
    expect(out).toContain(`data-src="${BASE}slides/week-1/games/a/i.html"`);
    expect(out).toContain(
      '<iframe src="https://www.youtube.com/embed/x" sandbox="allow-scripts allow-same-origin"></iframe>'
    );
    // Our frames lose the author's sandbox for the box.
    expect(out.match(new RegExp(`sandbox="${HTML_BLOCK_SANDBOX}"`, 'g'))).toHaveLength(2);
  });

  it('signs a background iframe on a section', async () => {
    const out = await rewrite(
      doc('<section data-background-iframe="games/bg/index.html"></section>')
    );
    expect(out).toContain(`data-background-iframe="${BASE}slides/week-1/games/bg/index.html"`);
  });

  it('makes inert what may not load, and marks it missing', async () => {
    const out = await rewrite(
      '<iframe src="javascript:alert(1)"></iframe>' +
        '<iframe src="https://app.classmoji.io/settings"></iframe>' +
        '<section data-background-iframe="/content/other/repo/x.html"></section>'
    );
    expect(out).toContain('data-cm-inert-src="javascript:alert(1)"');
    expect(out).toContain('data-cm-inert-src="https://app.classmoji.io/settings"');
    expect(out).toContain('data-cm-inert-data-background-iframe="/content/other/repo/x.html"');
    expect(out.match(new RegExp(`${FRAME_MISSING_ATTR}="1"`, 'g'))).toHaveLength(3);
    expect(out).not.toMatch(/\ssrc="/);
  });

  it('an html block naming anything but a repo file shows nothing, and loads nothing else', async () => {
    const out = await rewrite(
      '<iframe data-cm-src="https://evil.example/x.html" src="https://evil.example/x.html" ' +
        'data-src="https://evil.example/y.html" srcdoc="&lt;b&gt;"></iframe>' +
        '<iframe data-cm-src="javascript:alert(1)" data-src="blocks/a.html"></iframe>'
    );
    expect(out).toBe(
      `<iframe data-cm-inert-data-cm-src="https://evil.example/x.html" ${FRAME_MISSING_ATTR}="1"></iframe>` +
        `<iframe data-cm-inert-data-cm-src="javascript:alert(1)" ${FRAME_MISSING_ATTR}="1"></iframe>`
    );
  });

  it('an html block replaces whatever data-src it carried with its signed file', async () => {
    const out = await rewrite(
      '<iframe data-cm-src="blocks/a.html" data-src="https://evil.example/" src="x"></iframe>'
    );
    expect(out).toBe(
      `<iframe data-cm-src="blocks/a.html" data-src="${BASE}slides/week-1/blocks/a.html" sandbox="${HTML_BLOCK_SANDBOX}"></iframe>`
    );
  });

  it('ours that cannot be signed is inert too', async () => {
    const out = await rewrite('<iframe data-cm-src="blocks/missing.html"></iframe>');
    expect(out).toBe(
      `<iframe data-cm-inert-data-cm-src="blocks/missing.html" ${FRAME_MISSING_ATTR}="1"></iframe>`
    );
  });

  it('heals a leaked files URL or editor URL by signing it again', async () => {
    const leaked = `${BASE}slides/week-1/games/a/i.html?x=1`;
    const out = await rewrite(
      `<iframe src="${leaked}"></iframe><iframe src="/${SLIDE_ID}/frame/games/b/i.html?cm-rev=9"></iframe>` +
        `<iframe src="/${OTHER_SLIDE_ID}/frame/games/c/i.html"></iframe>`
    );
    expect(out).toContain(`src="${leaked}"`);
    expect(out).toContain(`src="${BASE}games/b/i.html"`);
    expect(out).toContain(`src="${BASE}games/c/i.html"`);
  });

  it('signs each target once per pass', async () => {
    sign.mockClear();
    await rewrite(
      '<iframe data-cm-src="blocks/a.html"></iframe><iframe data-cm-src="blocks/a.html"></iframe>'
    );
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('keeps a whole document a document', async () => {
    const out = await rewrite(doc('<section><iframe src="games/a.html"></iframe></section>'));
    expect(out.startsWith('<!DOCTYPE html><html><head><title>x</title>')).toBe(true);
  });
});

describe('canonicalizeFrameMarkup', () => {
  const opts = { deckFolder: DECK, slideId: SLIDE_ID, filesRef };

  it('turns files URLs and editor URLs back into deck-relative references', () => {
    expect(
      canonicalizeFrameMarkup(
        `<iframe src="${BASE}games/sketchkit/draw.html?deck=x"></iframe>` +
          `<iframe data-src="/${SLIDE_ID}/frame/slides/week-1/games/a/i.html?cm-rev=3#h"></iframe>`,
        opts
      )
    ).toBe(
      '<iframe src="../../games/sketchkit/draw.html?deck=x"></iframe>' +
        '<iframe data-src="games/a/i.html#h"></iframe>'
    );
  });

  it('an html block keeps data-cm-src and nothing that loads', () => {
    expect(
      canonicalizeFrameMarkup(
        `<iframe data-cm-src="blocks/a.html" data-cm-rev="r" src="${BASE}slides/week-1/blocks/a.html" data-src="x" srcdoc="&lt;b&gt;"></iframe>`,
        opts
      )
    ).toBe('<iframe data-cm-src="blocks/a.html" data-cm-rev="r"></iframe>');
  });

  it('drops display-only attributes anywhere', () => {
    expect(
      canonicalizeFrameMarkup(
        '<img src="a.png" data-cm-orig-src="assets/a.png"><iframe></iframe>',
        opts
      )
    ).toBe('<img src="a.png"><iframe></iframe>');
  });

  it("turns another deck's editor URL into a reference relative to this deck", () => {
    expect(
      canonicalizeFrameMarkup(
        `<iframe src="/${OTHER_SLIDE_ID}/frame/slides/other/games/a/i.html?cm-rev=1"></iframe>` +
          `<iframe src="https://slides.classmoji.io/${OTHER_SLIDE_ID}/frame/games/b/"></iframe>`,
        opts
      )
    ).toBe(
      '<iframe src="../other/games/a/i.html"></iframe>' +
        '<iframe src="../../games/b/index.html"></iframe>'
    );
  });

  it("an html block's reference is re-derived from the URL it showed", () => {
    expect(
      canonicalizeFrameMarkup(
        `<iframe data-cm-src="blocks/x.html" data-cm-rev="r" src="/${OTHER_SLIDE_ID}/frame/slides/other/blocks/x.html?cm-rev=r"></iframe>`,
        opts
      )
    ).toBe('<iframe data-cm-src="../other/blocks/x.html" data-cm-rev="r"></iframe>');
    expect(
      canonicalizeFrameMarkup(
        `<iframe data-cm-src="blocks/x.html" data-src="${BASE}slides/week-1/blocks/y.html"></iframe>`,
        opts
      )
    ).toBe('<iframe data-cm-src="blocks/y.html"></iframe>');
    // A URL that is not ours says nothing about the file.
    expect(
      canonicalizeFrameMarkup(
        '<iframe data-cm-src="blocks/x.html" src="https://example.com/a/frame/b.html"></iframe>',
        opts
      )
    ).toBe('<iframe data-cm-src="blocks/x.html"></iframe>');
  });

  it('leaves everything else byte for byte', () => {
    const html =
      '<iframe src="https://www.youtube.com/embed/x"  allowfullscreen></iframe><p>  x </p>' +
      '<iframe src="https://example.com/team/frame/b.html"></iframe>' +
      '<iframe src="/not-a-slide/frame/a/b.html"></iframe>';
    expect(canonicalizeFrameMarkup(html, opts)).toBe(html);
    expect(canonicalizeFrameMarkup('<p>no frames</p>', opts)).toBe('<p>no frames</p>');
  });

  it("another classroom's files URL is not undone", () => {
    const html = `<iframe src="${CONTENT}/c/aaaaaaaa-0000-4000-8000-000000000009/files/G/week.1.2.sig/a/b.html"></iframe>`;
    expect(canonicalizeFrameMarkup(html, opts)).toBe(html);
  });

  it('turns editor URLs back without being told the slide id', () => {
    const html = `<iframe src="/${SLIDE_ID}/frame/slides/week-1/a/b.html"></iframe>`;
    expect(canonicalizeFrameMarkup(html, { deckFolder: DECK, filesRef })).toBe(
      '<iframe src="a/b.html"></iframe>'
    );
  });
});

describe('canonicalizeDeckFrames', () => {
  const opts = { deckFolder: DECK, slideId: SLIDE_ID, filesRef };

  it('rewrites html, notes, section attrs and stacks; untouched slides keep identity', () => {
    const plain = { id: 's1', html: '<p>x</p>' };
    const deck = {
      theme: 'white',
      slides: [
        plain,
        {
          id: 's2',
          children: [
            {
              id: 's2a',
              html: `<iframe src="${BASE}slides/week-1/games/a.html"></iframe>`,
              attrs: {
                'data-background-iframe': `/${SLIDE_ID}/frame/games/bg.html`,
                'data-cm-orig-data-background-iframe': 'x',
              },
            },
          ],
        },
      ],
    } as unknown as DeckJson;
    const out = canonicalizeDeckFrames(deck, opts);
    expect(out.slides[0]).toBe(plain);
    const child = out.slides[1].children![0];
    expect(child.html).toBe('<iframe src="games/a.html"></iframe>');
    expect(child.attrs).toEqual({ 'data-background-iframe': '../../games/bg.html' });
    expect(deck.slides[1].children![0].attrs!['data-cm-orig-data-background-iframe']).toBe('x');
  });

  it('returns the same deck when nothing changes', () => {
    const deck = {
      theme: 'white',
      slides: [{ id: 's1', html: '<iframe src="games/a.html"></iframe>' }],
    } as unknown as DeckJson;
    expect(canonicalizeDeckFrames(deck, opts)).toBe(deck);
  });
});
