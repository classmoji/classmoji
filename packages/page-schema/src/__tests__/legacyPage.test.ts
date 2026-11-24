/**
 * `convertLegacyPageHtml` / `legacyPageLinkIds` (`../html.ts`): the legacy
 * page conversion (the operator script's), as a pure function. The script's
 * suite (packages/tasks/src/helpers/__tests__/legacyPageConversion.test.ts)
 * pins what is written with it; this pins the function's own rules.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  convertLegacyPageHtml,
  htmlToPageBlocks,
  legacyPageLinkIds,
  type HtmlToPageBlocksOptions,
  type PageBlock,
} from '../html.ts';

const PAGE_A = '11111111-1111-4111-8111-111111111111';
const PAGE_B = '22222222-2222-4222-8222-222222222222';

/** A stand-in id rule: `id-<n>` in walk order, for blocks with no id. */
function fakeEnsureBlockIds<T>(blocks: T[]): T[] {
  let n = 0;
  const fill = (list: PageBlock[]): PageBlock[] =>
    list.map(block => ({
      ...block,
      id: block.id ?? `id-${n++}`,
      ...(block.children ? { children: fill(block.children) } : {}),
    }));
  return fill(structuredClone(blocks) as unknown as PageBlock[]) as unknown as T[];
}

function walk(blocks: PageBlock[], out: PageBlock[] = []): PageBlock[] {
  for (const block of blocks) {
    out.push(block);
    if (block.children) walk(block.children, out);
  }
  return out;
}

function hrefs(blocks: PageBlock[]): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const item = value as { type?: string; href?: string };
      if (item.type === 'link' && item.href) out.push(item.href);
      Object.values(value).forEach(visit);
    }
  };
  visit(blocks);
  return out;
}

describe('legacyPageLinkIds', () => {
  it('every uuid-shaped string, lowercase, once, in order', () => {
    const html =
      `<p><a href="/cs1/pages/${PAGE_B.toUpperCase()}">b</a> ${PAGE_A}</p>` +
      `<p><a href="/cs1/pages/${PAGE_B}">b again</a></p>`;
    expect(legacyPageLinkIds(html)).toEqual([PAGE_B, PAGE_A]);
    expect(legacyPageLinkIds('<p>none</p>')).toEqual([]);
  });
});

describe('convertLegacyPageHtml', () => {
  const html =
    `<!DOCTYPE html><html><body><h1>Week 1</h1>` +
    `<p><a href="/old-slug/pages/${PAGE_A}">here</a> and <a href="/old-slug/pages/${PAGE_B}">gone</a></p>` +
    `<div class="callout"><span>Note</span></div></body></html>`;

  it('rewrites only links to pages of the classroom, at its slug', async () => {
    const blocks = await convertLegacyPageHtml(html, {
      title: 'Week 1',
      classroomSlug: 'cs52',
      pagesInClassroom: new Set([PAGE_A]),
      ensureBlockIds: fakeEnsureBlockIds,
    });
    expect(hrefs(blocks)).toEqual([`/cs52/${PAGE_A}`, `/old-slug/pages/${PAGE_B}`]);
    // The title <h1> is the page row's, so it is dropped.
    expect(walk(blocks).some(block => block.type === 'heading')).toBe(false);
  });

  it('keeps the link’s own slug when the classroom has none', async () => {
    const blocks = await convertLegacyPageHtml(html, {
      title: 'Week 1',
      pagesInClassroom: new Set([PAGE_A, PAGE_B]),
      ensureBlockIds: fakeEnsureBlockIds,
    });
    expect(hrefs(blocks)).toEqual([`/old-slug/${PAGE_A}`, `/old-slug/${PAGE_B}`]);
  });

  it('drops the converter’s uuids for the id rule’s, at every depth', async () => {
    const ensure = vi.fn(fakeEnsureBlockIds);
    const blocks = await convertLegacyPageHtml(
      '<details><summary>More</summary><p>inside</p></details>',
      {
        title: 'T',
        pagesInClassroom: new Set(),
        ensureBlockIds: ensure as unknown as typeof fakeEnsureBlockIds,
      }
    );
    expect(ensure).toHaveBeenCalledTimes(1);
    const given = ensure.mock.calls[0][0] as PageBlock[];
    expect(walk(given).every(block => !('id' in block))).toBe(true);
    expect(walk(blocks).every(block => /^id-\d+$/.test(block.id ?? ''))).toBe(true);
    expect(walk(blocks).length).toBeGreaterThan(1);
  });

  it('is htmlToPageBlocks with the title and the classroom resolver, ids aside', async () => {
    const convert = vi.fn((input: string, options: HtmlToPageBlocksOptions) =>
      htmlToPageBlocks(input, options)
    );
    const viaShared = await convertLegacyPageHtml(html, {
      title: 'Week 1',
      classroomSlug: 'cs52',
      pagesInClassroom: new Set([PAGE_A]),
      ensureBlockIds: fakeEnsureBlockIds,
      convert,
    });
    const options = convert.mock.calls[0][1];
    expect(options.title).toBe('Week 1');
    expect(options.resolvePageLink?.('x', PAGE_A)).toBe(`/cs52/${PAGE_A}`);
    expect(options.resolvePageLink?.('x', PAGE_B)).toBeNull();
    expect(options.resolvePageLink?.('x', 'not-a-uuid')).toBeNull();
    const direct = await htmlToPageBlocks(html, options);
    const strip = (blocks: PageBlock[]) =>
      JSON.parse(JSON.stringify(blocks, (key, value) => (key === 'id' ? undefined : value)));
    expect(strip(viaShared)).toEqual(strip(direct));
  });

  it('throws what the converter throws', async () => {
    await expect(
      convertLegacyPageHtml('<p>x</p>', {
        title: 'T',
        pagesInClassroom: new Set(),
        ensureBlockIds: fakeEnsureBlockIds,
        convert: async () => {
          throw new Error('converter blew up');
        },
      })
    ).rejects.toThrow('converter blew up');
  });
});
