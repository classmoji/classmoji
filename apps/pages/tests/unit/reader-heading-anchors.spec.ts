/**
 * The reader's `#fragment` ids (components/viewer/headingAnchors.ts) are the
 * ones the class site's old static render gave the same headings: the same
 * slug and the same `-2` rule, so `#heading` links shared before the site
 * moved to the reader island still land. The expected ids were taken from
 * that render (`renderSitePage(...).headings`) before it was deleted; the
 * reader's ids come from the ProseMirror document BlockNote builds from the
 * same blocks (the page schema without React, which the parity spec pins to
 * the client's).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { BlockNoteEditor } from '@blocknote/core';
import { createPageSchema, normalizeCodeBlockContent } from '@classmoji/page-schema';

import { headingAnchorTargets } from '~/components/viewer/headingAnchors.ts';
import { redactDocumentForViewer } from '~/utils/linkRedaction.server.ts';
import { createHeadingIdAllocator, hashTarget, slugifyHeading } from '~/utils/headingAnchors.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const heading = (level: number, value: string, props: Record<string, unknown> = {}) => ({
  type: 'heading',
  props: { level, ...props },
  content: value ? text(value) : [],
  children: [],
});

const KITCHEN_SINK = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../../packages/page-schema/src/__tests__/fixtures/kitchen-sink.content.json',
          import.meta.url
        )
      ),
      'utf8'
    )
  ) as { blocks: unknown[] }
).blocks;

/** Each document, and the ids the class site's static render gave its headings. */
const FIXTURES: Record<string, { blocks: unknown[]; siteIds: string[] }> = {
  'kitchen sink': {
    blocks: KITCHEN_SINK,
    siteIds: [
      'kitchen-sink',
      'lists',
      'toggle-heading',
      'left-column',
      'step-1-a-checkable-section',
      'a-checkable-heading-inside-the-lock',
    ],
  },
  'duplicates, empty, deep, toggle, checkable, nested, punctuation': {
    blocks: [
      heading(1, 'Grading'),
      heading(2, 'Grading'),
      heading(3, ''),
      heading(2, 'Grading'),
      heading(4, 'Too deep'),
      heading(2, 'Week 1: Setup & Tools', { isToggleable: true }),
      heading(2, 'Checkpoint', { checkable: true }),
      {
        type: 'bulletListItem',
        props: {},
        content: text('An item'),
        children: [heading(3, 'Nested under a list')],
      },
      heading(1, '!!!'),
      heading(1, '???'),
      { type: 'paragraph', props: {}, content: text('Body text, not a heading.'), children: [] },
    ],
    siteIds: [
      'grading',
      'grading-2',
      'grading-3',
      'week-1-setup-tools',
      'checkpoint',
      'nested-under-a-list',
      'section',
      'section-2',
    ],
  },
};

/** The ids the reader's decoration gives the same document, in order. */
function readerIds(blocks: unknown[]): string[] {
  const editor = BlockNoteEditor.create({
    schema: createPageSchema(),
    initialContent: blocks as never,
  });
  return headingAnchorTargets(editor.prosemirrorState.doc).map(target => target.id);
}

test.describe('heading ids: the reader matches the class site', () => {
  for (const [name, { blocks: fixture, siteIds }] of Object.entries(FIXTURES)) {
    test(name, () => {
      // The document the reader is handed: links redacted for a viewer who
      // may open nothing, code blocks as plain text (the payload's own steps).
      const blocks = normalizeCodeBlockContent(redactDocumentForViewer(fixture, () => null));
      const ids = readerIds(blocks as unknown[]);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).toEqual(siteIds);
    });
  }

  test('the rule itself: one slug, the -2 numbering, empty headings use nothing up', () => {
    expect(slugifyHeading('!!!')).toBe('section');
    expect(slugifyHeading('  Hello   World  ')).toBe('hello-world');
    expect(slugifyHeading('Grading & Late Work')).toBe('grading-late-work');
    const next = createHeadingIdAllocator();
    expect(['Grading', 'Grading', '', '  ', 'Grading', '!!!', '???'].map(next)).toEqual([
      'grading',
      'grading-2',
      null,
      null,
      'grading-3',
      'section',
      'section-2',
    ]);
  });

  test('a hash finds its element, encoded or not; a bad one finds nothing', () => {
    const calls: string[] = [];
    const root = { getElementById: (id: string) => (calls.push(id), null) } as unknown as Document;
    hashTarget('#week-1', root);
    hashTarget('#caf%C3%A9', root);
    hashTarget('#%E0%A4%A', root);
    expect(hashTarget('', root)).toBeNull();
    expect(calls).toEqual(['week-1', 'café', '%E0%A4%A']);
  });
});
