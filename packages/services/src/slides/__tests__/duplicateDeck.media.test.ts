/**
 * Duplicating a deck keeps its `media://` references exactly as they are.
 *
 * The slides index's "duplicate" copies the deck's folder in the SAME content
 * repo and then runs its `index.html` and `deck.json` through the classroom
 * import's URL rewriter (`contentImport.rewriteContentUrls`), with the source
 * and the target both this classroom. A media reference names a row, not a
 * path: the copy is in the same classroom as the object, so the reference is
 * valid in the copy as it stands and must come out byte-identical — rewriting
 * it would point the copy at something else, and copying the object would bill
 * the classroom twice for one video.
 *
 * Pinned here, beside the deck engine, because the rewriter is shared with the
 * cross-classroom import, where a media reference DOES have to change (the
 * object is copied into the destination and the reference remapped). A change
 * made for that caller must not reach this one.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({}),
}));
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: vi.fn(), batchTrigger: vi.fn() } }));

const { rewriteContentUrls } = await import('../../classmoji/contentImport.service.ts');

const ORG = 'test-org';
const REPO = 'content-test-org-cs101';
const MEDIA_REF = 'media://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** The context the index route's duplicate builds: same repo, new folder. */
const duplicateCtx = {
  sourceLogin: ORG,
  sourceRepo: REPO,
  sourcePath: 'slides/week-3',
  targetLogin: ORG,
  targetRepo: REPO,
  targetPath: 'slides/week-3-copy-1760000000000',
  shaPaths: new Map<string, string>(),
  targetHasPath: () => true,
  onUncopiedRef: () => {},
  onWarn: () => {},
};

describe('duplicate deck — media references', () => {
  it('leaves every media reference in index.html byte-identical', () => {
    const html = [
      `<section data-background-video="${MEDIA_REF}"></section>`,
      `<section><video src="${MEDIA_REF}" controls></video></section>`,
      `<section><video><source src="${MEDIA_REF}" type="video/mp4"></video></section>`,
      `<section><img src="/content/${ORG}/${REPO}/slides/week-3/images/a.png"></section>`,
    ].join('');

    const out = rewriteContentUrls(html, duplicateCtx);

    expect(out.split(MEDIA_REF).length - 1).toBe(3);
    // The repo reference beside them still moves to the copy's folder, so the
    // pass really ran.
    expect(out).toContain(`/content/${ORG}/${REPO}/slides/week-3-copy-1760000000000/images/a.png`);
  });

  it('leaves every media reference in deck.json byte-identical', () => {
    const deck = JSON.stringify(
      {
        version: 1,
        theme: 'white',
        slides: [
          { id: 'a1', html: `<video src="${MEDIA_REF}"></video>` },
          { id: 'b2', html: '<p>bg</p>', attrs: { 'data-background-video': MEDIA_REF } },
        ],
      },
      null,
      2
    );

    expect(rewriteContentUrls(deck, duplicateCtx)).toBe(deck);
  });
});
