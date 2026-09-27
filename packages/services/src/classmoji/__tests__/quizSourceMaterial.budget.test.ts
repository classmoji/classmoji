/**
 * applyMaterialBudget — the pure step that fits a quiz's source material into
 * the prompt. No database: documents in, budgeted documents out.
 *
 * Pinned: the paragraph cut (last blank line inside the final 20% before the
 * limit), the hard cut when there is none, the one marker line and its text,
 * the running total across documents (a document crossing it is cut to what is
 * left; anything after it is `budget`), the document cap, and zero documents.
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
  it('are 12 documents, 60,000 characters each, 160,000 in all', () => {
    expect(MAX_DOCS).toBe(12);
    expect(MAX_CHARS_PER_DOC).toBe(60_000);
    expect(MAX_CHARS_TOTAL).toBe(160_000);
    expect(DEFAULT_MATERIAL_BUDGET).toEqual({
      maxDocs: 12,
      maxCharsPerDoc: 60_000,
      maxCharsTotal: 160_000,
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
    const limits = { maxDocs: 12, maxCharsPerDoc: 100, maxCharsTotal: 150 };
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
