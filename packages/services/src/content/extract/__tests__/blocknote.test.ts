import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { extractText, KNOWN_BLOCK_TYPES } from '../index.ts';
import {
  ALL_BLOCKS,
  EXPECTED_ABSENT,
  EXPECTED_REFERENCES,
  EXPECTED_TEXT,
} from './fixtures/allBlocks.ts';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const blocknote = (json: unknown, title?: string) =>
  extractText({ kind: 'blocknote', json: json as string | unknown[] }, title ? { title } : {});

/**
 * `collectText` as it stands at `apps/mcp/src/tools/pageContent.ts:69-82`, and
 * its only caller `blockPreview` (:85-90), which passes `block.content`.
 *
 * Kept here verbatim so the acceptance criterion is a test rather than a claim:
 * the blocks this extractor exists for come out of the old one as ''.
 */
function legacyCollectText(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) legacyCollectText(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.text === 'string') out.push(record.text);
  for (const key of ['content', 'rows', 'cells']) {
    if (record[key]) legacyCollectText(record[key], out);
  }
}

function legacyPreview(block: unknown): string {
  const parts: string[] = [];
  legacyCollectText((block as { content?: unknown }).content, parts);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

describe('extractText — blocknote', () => {
  it('covers every block type in the editor schema', () => {
    const present = new Set(
      ALL_BLOCKS.flatMap(function types(block: unknown): string[] {
        const node = block as { type?: string; children?: unknown[] };
        return [node.type ?? '', ...(node.children ?? []).flatMap(types)];
      })
    );
    for (const type of KNOWN_BLOCK_TYPES) {
      expect(present, `fixture is missing a ${type} block`).toContain(type);
    }
    expect(KNOWN_BLOCK_TYPES).toHaveLength(21);
  });

  it('carries the text out of every block type that has its own words', () => {
    const { ok, text } = blocknote(ALL_BLOCKS);
    expect(ok).toBe(true);
    for (const expected of EXPECTED_TEXT) {
      expect(text, `missing ${expected}`).toContain(expected);
    }
  });

  it('recurses children — columnList → column → heading/paragraph', () => {
    const { text } = blocknote(ALL_BLOCKS);
    expect(text).toContain('COLUMN_HEADING_TEXT');
    expect(text).toContain('COLUMN_PARAGRAPH_TEXT');
    expect(text).toContain('BULLET_NESTED_TEXT');
    expect(text).toContain('TOGGLE_CHILD_TEXT');
  });

  it('reads prop-carried text — terminal, profile, image, file, video', () => {
    const { text } = blocknote(ALL_BLOCKS);
    expect(text).toContain('TERMINAL_CODE npm run dev');
    expect(text).toContain('TERMINAL_TITLE');
    expect(text).toContain('PROFILE_NAME');
    expect(text).toContain('IMAGE_CAPTION');
    expect(text).toContain('FILE_NAME.pdf');
    expect(text).toContain('VIDEO_CAPTION');
  });

  it('never emits formatting props, asset URLs or ids', () => {
    const { text } = blocknote(ALL_BLOCKS);
    for (const noise of EXPECTED_ABSENT) {
      expect(text, `leaked ${noise}`).not.toContain(noise);
    }
  });

  it('separates blocks with a newline so a heading does not run into the next paragraph', () => {
    const { text } = blocknote(ALL_BLOCKS);
    expect(text).toContain('HEADING_TEXT\nPARAGRAPH_TEXT');
    expect(text).not.toContain('HEADING_TEXTPARAGRAPH_TEXT');
    // Table rows are lines too.
    expect(text).toContain('TABLE_HEAD_A TABLE_HEAD_B\nTABLE_CELL_A TABLE_CELL_B');
  });

  it('prepends the title when one is given', () => {
    const { text } = blocknote(ALL_BLOCKS, 'Assessment Schedule');
    expect(text.split('\n')[0]).toBe('Assessment Schedule');
  });

  it('reports no notes for a page', () => {
    expect(blocknote(ALL_BLOCKS).notes).toBe('');
  });

  it('accepts both stored shapes — the { blocks } wrapper and a bare array', () => {
    const wrapped = blocknote({ blocks: ALL_BLOCKS, coverImage: { url: 'x', position: 50 } });
    const bare = blocknote(ALL_BLOCKS);
    const asString = blocknote(JSON.stringify({ blocks: ALL_BLOCKS }));
    expect(wrapped.text).toBe(bare.text);
    expect(asString.text).toBe(bare.text);
  });

  it('treats an absent document as empty and an unreadable one as a failure', () => {
    for (const absent of [null, undefined, '', '   ']) {
      expect(blocknote(absent)).toEqual({ ok: true, text: '', notes: '', references: [] });
    }
    for (const broken of ['not json', '[', '{', {}, 42, { blocks: 'nope' }]) {
      expect(() => blocknote(broken)).not.toThrow();
      const result = blocknote(broken);
      expect(result.ok, `for ${JSON.stringify(broken) ?? String(broken)}`).toBe(false);
      expect(result.text).toBe('');
      expect(result.error).toMatch(/could not be parsed/);
    }
  });

  it("the OLD collectText yields '' for exactly the blocks this extractor exists for", () => {
    const byId = (id: string) => ALL_BLOCKS.find(b => (b as { id?: string }).id === id);
    for (const id of ['b-terminal', 'b-navgrid', 'b-columnlist', 'b-profile', 'b-image']) {
      expect(legacyPreview(byId(id)), `${id} unexpectedly had content`).toBe('');
    }
    const { text } = blocknote(ALL_BLOCKS);
    expect(text).not.toBe('');
    expect(text).toContain('TERMINAL_CODE npm run dev');
    expect(text).toContain('COLUMN_HEADING_TEXT');
  });
});

describe('extractText — cross-references never enter the text', () => {
  it('returns pageLink and navGrid targets in references, not their labels in text', () => {
    const { text, references } = blocknote(ALL_BLOCKS);

    expect(references).toEqual(EXPECTED_REFERENCES);

    // Targets only. Labels, titles and ids all stay out of the embedded text.
    expect(text).not.toContain('PAGELINK_TITLE');
    expect(text).not.toContain('NAVGRID_PAGE_TITLE');
    expect(text).not.toContain('NAVGRID_EXTERNAL_LABEL');
    expect(text).not.toContain('Schedule');
    // The JSON envelope itself never lands in the index either.
    expect(text).not.toContain('"kind"');
    expect(text).not.toContain('pageId');
  });

  it('keeps a draft page title out of a published page that links to it', () => {
    // The containing page is published; the two things it points at are not.
    // This page's `is_draft` says nothing about theirs, so neither title may
    // ride along into a student-visible snippet.
    const page = [
      {
        id: 'p1',
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Everything you need is linked below.', styles: {} }],
        children: [],
      },
      {
        id: 'p2',
        type: 'pageLink',
        props: { pageId: 'draft-page-uuid', pageTitle: 'Exam 2 Solutions' },
        children: [],
      },
      {
        id: 'p3',
        type: 'navGrid',
        props: {
          entries: JSON.stringify([
            { kind: 'page', pageId: 'other-draft-uuid', title: 'Unreleased Final Project' },
          ]),
          columns: 2,
        },
        children: [],
      },
    ];

    const { ok, text, references } = blocknote(page, 'Course Home');

    expect(ok).toBe(true);
    expect(text).toBe('Course Home\nEverything you need is linked below.');
    expect(text).not.toContain('Exam 2 Solutions');
    expect(text).not.toContain('Unreleased Final Project');
    expect(references).toEqual([
      { kind: 'page', id: 'draft-page-uuid' },
      { kind: 'page', id: 'other-draft-uuid' },
    ]);
  });

  it('drops an entry whose URL cannot be made safe', () => {
    const page = [
      {
        id: 'n1',
        type: 'navGrid',
        props: {
          entries: JSON.stringify([
            { kind: 'external', url: 'javascript:alert(1)', label: 'Click me' },
          ]),
        },
        children: [],
      },
    ];
    const { text, references } = blocknote(page);
    expect(references).toEqual([]);
    expect(text).toBe('');
  });
});

describe('extractText — blocknote, real cs52 pages', () => {
  it('pulls profile names out of a real columnList page', () => {
    const { text } = blocknote(fixture('cs52-page-home.content.json'), 'Dartmouth CS52');

    expect(text.split('\n')[0]).toBe('Dartmouth CS52');
    // Every one of these is a `profile` block nested two deep inside a
    // columnList: prop-carried text behind a children recursion.
    expect(text).toContain('Tim Tregubov');
    expect(text).toContain('Head Coach');
    expect(text).toContain('Teaching Assistant');
    // A heading that lives at the top level, to prove both paths run.
    expect(text).toContain('Staff Directory');
    expect(text).not.toContain('backgroundColor');
    expect(text).not.toContain('raw.githubusercontent.com');
  });

  it('keeps a real pageLink target out of the text and in the references', () => {
    const { text, references } = blocknote(fixture('cs52-page-prelab4.content.json'));

    expect(text).not.toContain('Lab 4:  Platform Frontend');
    expect(references).toEqual([{ kind: 'page', id: '3797f749-d384-425a-85d5-d5f519078e2c' }]);
    expect(text.length).toBeGreaterThan(200);
  });
});
