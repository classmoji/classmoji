/**
 * applyMaterialBudget — the pure step that fits a quiz's source material into
 * the prompt. No database: documents in, budgeted documents out.
 *
 * Pinned: the paragraph cut (last blank line inside the final 20% before the
 * limit), the hard cut when there is none, the one marker line and its text,
 * the running total across documents (a document crossing it is cut to what is
 * left; anything after it is `budget`, never a sliver), the minimum room below
 * which nothing more is cut, the exact edges of both limits, surrogate-pair
 * safety, the document cap, and zero documents.
 */

import { describe, expect, it, vi } from 'vitest';

// The module imports these for its database half; the budget never reaches them.
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const {
  applyMaterialBudget,
  cutText,
  truncationMarker,
  DEFAULT_MATERIAL_BUDGET,
  MAX_DOCS,
  MAX_CHARS_PER_DOC,
  MAX_CHARS_TOTAL,
  MIN_ROOM_CHARS,
} = await import('../quizSourceMaterial.service.ts');

type Doc = Parameters<typeof applyMaterialBudget>[0][number];

const doc = (id: string, text: string, kind: 'page' | 'slide' = 'page'): Doc => ({
  kind,
  id,
  title: `Title ${id}`,
  text,
  truncated: false,
  sourceSha: `sha-${id}`,
});

describe('budget constants (Tim, 2026-09-26)', () => {
  it('are 12 documents, 60,000 characters each, 160,000 in all, no cut into under 2,000', () => {
    expect(MAX_DOCS).toBe(12);
    expect(MAX_CHARS_PER_DOC).toBe(60_000);
    expect(MAX_CHARS_TOTAL).toBe(160_000);
    expect(MIN_ROOM_CHARS).toBe(2_000);
    expect(DEFAULT_MATERIAL_BUDGET).toEqual({
      maxDocs: 12,
      maxCharsPerDoc: 60_000,
      maxCharsTotal: 160_000,
      minRoomChars: 2_000,
    });
  });
});

describe('truncationMarker', () => {
  it('names the characters cut and the original length, with thousands separators', () => {
    expect(truncationMarker(12_400, 71_900)).toBe('[… 12,400 of 71,900 characters omitted]');
  });
});

describe('cutText', () => {
  it('leaves text that fits alone', () => {
    expect(cutText('short', 10)).toEqual({ kept: 'short', cut: 0 });
  });

  it('cuts at the last blank line inside the final 20% before the limit', () => {
    // limit 100 → window starts at 80. Blank lines at 50 and 90: the one at 90
    // is inside the window and is the last one, so the cut lands there.
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(38)}\n\n${'c'.repeat(60)}`;
    const blankAt = text.indexOf('\n\n', 60);
    expect(blankAt).toBe(90);

    const { kept, cut } = cutText(text, 100);
    expect(kept).toBe(text.slice(0, 90));
    expect(cut).toBe(text.length - 90);
  });

  it('treats a line of only spaces or tabs as blank', () => {
    const text = `${'a'.repeat(85)}\n \t\n${'b'.repeat(40)}`;
    expect(cutText(text, 100).kept).toBe('a'.repeat(85));
  });

  it('hard-cuts at the limit when the only blank line is before the window', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(200)}`;
    const { kept, cut } = cutText(text, 100);
    expect(kept).toBe(text.slice(0, 100));
    expect(cut).toBe(text.length - 100);
  });

  it('hard-cuts at the limit when there is no blank line at all', () => {
    const text = 'x'.repeat(250);
    expect(cutText(text, 100)).toEqual({ kept: 'x'.repeat(100), cut: 150 });
  });

  it('never splits a surrogate pair on a hard cut', () => {
    // Each emoji is two UTF-16 code units; an odd limit lands between them.
    const text = '😀'.repeat(60);
    expect(cutText(text, 51)).toEqual({ kept: '😀'.repeat(25), cut: 70 });
    expect(cutText(text, 50)).toEqual({ kept: '😀'.repeat(25), cut: 70 });
    expect(cutText(`a${text}`, 51)).toEqual({ kept: `a${'😀'.repeat(25)}`, cut: 70 });
  });
});

describe('applyMaterialBudget', () => {
  it('returns nothing for no documents', () => {
    expect(applyMaterialBudget([])).toEqual({
      docs: [],
      omitted: [],
      truncated: false,
      totalChars: 0,
    });
  });

  it('keeps documents that fit, in order and unchanged', () => {
    const docs = [doc('1', 'one'), doc('2', 'two', 'slide')];
    const result = applyMaterialBudget(docs);

    expect(result.docs).toEqual(docs);
    expect(result.omitted).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.totalChars).toBe(6);
  });

  it('cuts a long document and appends exactly one marker line', () => {
    const text = 'x'.repeat(250);
    const result = applyMaterialBudget([doc('1', text)], {
      maxDocs: 12,
      maxCharsPerDoc: 100,
      maxCharsTotal: 1_000,
      minRoomChars: 10,
    });

    const [only] = result.docs;
    expect(only.truncated).toBe(true);
    expect(only.text).toBe(`${'x'.repeat(100)}\n\n[… 150 of 250 characters omitted]`);
    expect(only.text.match(/characters omitted/g)).toHaveLength(1);
    expect(only.sourceSha).toBe('sha-1');
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(only.text.length);
  });

  it('cuts the document that crosses the total to what is left, and omits the rest as budget', () => {
    const limits = { maxDocs: 12, maxCharsPerDoc: 100, maxCharsTotal: 150, minRoomChars: 10 };
    const result = applyMaterialBudget(
      [doc('1', 'a'.repeat(100)), doc('2', 'b'.repeat(100)), doc('3', 'c'.repeat(10))],
      limits
    );

    expect(result.docs.map(d => d.id)).toEqual(['1', '2']);
    expect(result.docs[0].truncated).toBe(false);
    // 50 characters of room were left for doc 2.
    expect(result.docs[1].text).toBe(`${'b'.repeat(50)}\n\n[… 50 of 100 characters omitted]`);
    expect(result.omitted).toEqual([{ kind: 'page', id: '3', title: 'Title 3', reason: 'budget' }]);
    expect(result.truncated).toBe(true);
  });

  it('takes nothing after a document cut to fit the total, even what would fit whole', () => {
    // Doc 3 crosses the total (50 left) and is cut at its blank line after 42
    // characters, leaving 8. Doc 4 would fit whole in those 8, but the total is
    // spent: a sliver of material is not worth its place.
    const limits = { maxDocs: 12, maxCharsPerDoc: 100, maxCharsTotal: 250, minRoomChars: 5 };
    const third = `${'c'.repeat(42)}\n\n${'c'.repeat(80)}`;
    const result = applyMaterialBudget(
      [doc('1', 'a'.repeat(100)), doc('2', 'b'.repeat(100)), doc('3', third), doc('4', 'tiny')],
      limits
    );

    expect(result.docs.map(d => d.id)).toEqual(['1', '2', '3']);
    expect(result.docs[2].text.startsWith(`${'c'.repeat(42)}\n\n[… `)).toBe(true);
    expect(result.omitted).toEqual([{ kind: 'page', id: '4', title: 'Title 4', reason: 'budget' }]);
  });

  it('cuts to the per-document limit without spending the total', () => {
    const limits = { maxDocs: 12, maxCharsPerDoc: 100, maxCharsTotal: 1_000, minRoomChars: 10 };
    const result = applyMaterialBudget([doc('1', 'x'.repeat(250)), doc('2', 'y'.repeat(80))], limits);

    expect(result.docs.map(d => [d.id, d.truncated])).toEqual([
      ['1', true],
      ['2', false],
    ]);
    expect(result.omitted).toEqual([]);
  });

  it('leaves a document out rather than cutting it into less than the minimum room', () => {
    // 60,000 + 60,000 + 39,000 leaves 1,000: under MIN_ROOM_CHARS, so the next
    // document is budget instead of a 1,000-character sliver.
    const result = applyMaterialBudget([
      doc('1', 'a'.repeat(60_000)),
      doc('2', 'b'.repeat(60_000)),
      doc('3', 'c'.repeat(39_000)),
      doc('4', 'd'.repeat(50_000)),
    ]);

    expect(result.docs.map(d => d.id)).toEqual(['1', '2', '3']);
    expect(result.docs.every(d => !d.truncated)).toBe(true);
    expect(result.omitted).toEqual([{ kind: 'page', id: '4', title: 'Title 4', reason: 'budget' }]);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(159_000);
  });

  it('keeps a document of exactly the per-document limit whole, with no marker', () => {
    const [only] = applyMaterialBudget([doc('1', 'z'.repeat(MAX_CHARS_PER_DOC))]).docs;

    expect(only.truncated).toBe(false);
    expect(only.text).toBe('z'.repeat(MAX_CHARS_PER_DOC));
  });

  it('keeps documents that land exactly on the total whole, and takes nothing after', () => {
    const docs = [
      doc('1', 'a'.repeat(60_000)),
      doc('2', 'b'.repeat(60_000)),
      doc('3', 'c'.repeat(40_000)),
    ];
    const exact = applyMaterialBudget(docs);

    expect(exact.docs.map(d => d.truncated)).toEqual([false, false, false]);
    expect(exact.totalChars).toBe(MAX_CHARS_TOTAL);
    expect(exact.omitted).toEqual([]);
    expect(exact.truncated).toBe(false);

    const over = applyMaterialBudget([...docs, doc('4', 'd')]);
    expect(over.docs).toHaveLength(3);
    expect(over.omitted).toEqual([{ kind: 'page', id: '4', title: 'Title 4', reason: 'budget' }]);
    expect(over.truncated).toBe(true);
  });

  it('stops at the document cap and omits the rest as budget', () => {
    const docs = Array.from({ length: MAX_DOCS + 2 }, (_, i) => doc(String(i), `doc ${i}`));
    const result = applyMaterialBudget(docs);

    expect(result.docs).toHaveLength(MAX_DOCS);
    expect(result.omitted.map(d => d.id)).toEqual([String(MAX_DOCS), String(MAX_DOCS + 1)]);
    expect(result.omitted.every(d => d.reason === 'budget')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('applies the default budget: a 70,000-character document is cut to 60,000', () => {
    const text = 'y'.repeat(70_000);
    const [only] = applyMaterialBudget([doc('1', text)]).docs;

    expect(only.text.startsWith('y'.repeat(60_000))).toBe(true);
    expect(only.text.endsWith('[… 10,000 of 70,000 characters omitted]')).toBe(true);
  });
});
