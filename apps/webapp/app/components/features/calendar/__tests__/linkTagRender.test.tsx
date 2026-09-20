/**
 * The chip a linked resource gets in the add/edit modals, and the star on it.
 *
 * Rendered to static markup rather than driven through antd: what is worth
 * pinning is the chip's own contract — a real `<button>` that announces its
 * pressed state, a Draft pill only where the option says draft, a plain "+N"
 * for the overflow tag — and that is all in the markup. The behaviour that
 * needs a live Select (starring one clears the other, unlinking clears the
 * star) is covered by the Playwright specs.
 */

import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tooltip } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  buildLinkOptions,
  createLinkTagRender,
  eventLinkMeta,
  featuredAfterSelection,
  FEATURED_TOOLTIP,
  mergeLinkMeta,
  nextFeatured,
  renderLinkOption,
  UNNAMED_LINK,
  type FeaturedRef,
} from '../linkTagRender';

const ITEMS = [
  { id: 'p-1', title: 'Week 1 reading' },
  { id: 'p-2', title: 'Unfinished notes', is_draft: true },
];

const renderTag = (
  featured: FeaturedRef | null,
  value: string,
  overrides: Partial<Parameters<ReturnType<typeof createLinkTagRender>>[0]> = {}
) => {
  const { meta } = buildLinkOptions(ITEMS);
  const tagRender = createLinkTagRender({
    kind: 'page',
    meta,
    featured,
    onToggleFeatured: vi.fn(),
  });

  return renderToStaticMarkup(
    tagRender({
      label: meta.get(value)?.title ?? value,
      value,
      closable: true,
      onClose: vi.fn(),
      ...overrides,
    })
  );
};

describe('buildLinkOptions', () => {
  it('keeps the label a plain string, because search matches on it', () => {
    // `optionFilterProp="label"` compares against this value. A React element
    // here makes a page unfindable by typing its name.
    const { options } = buildLinkOptions(ITEMS);

    expect(options).toEqual([
      { value: 'p-1', label: 'Week 1 reading', is_draft: false },
      { value: 'p-2', label: 'Unfinished notes', is_draft: true },
    ]);
  });

  it('takes a label builder for the assignments picker', () => {
    const { options, meta } = buildLinkOptions(
      [{ id: 'a-1', title: 'HW 1' }],
      a => `Homework: ${a.title}`
    );

    expect(options[0].label).toBe('Homework: HW 1');
    // The meta map has to agree, or a tag and its dropdown row name the same
    // resource differently.
    expect(meta.get('a-1')?.title).toBe('Homework: HW 1');
  });
});

describe('the tag', () => {
  it('offers the star as a real button', () => {
    const html = renderTag(null, 'p-1');

    expect(html).toContain('aria-label="Show Week 1 reading in month view"');
    expect(html).toContain('<button type="button"');
  });

  it('puts the explanation on a Tooltip around it', () => {
    // A Tooltip renders nothing until it is hovered, so this reads the element
    // tree rather than the markup — the string is what a user eventually sees.
    const { meta } = buildLinkOptions(ITEMS);
    const tag = createLinkTagRender({
      kind: 'page',
      meta,
      featured: null,
      onToggleFeatured: vi.fn(),
    })({ label: 'Week 1 reading', value: 'p-1', closable: true, onClose: vi.fn() });

    const tooltips: unknown[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isValidElement(node)) return;
      const props = node.props as { title?: unknown; children?: unknown };
      if (node.type === Tooltip) tooltips.push(props.title);
      walk(props.children);
    };
    walk(tag);

    expect(tooltips).toEqual([FEATURED_TOOLTIP]);
    expect(FEATURED_TOOLTIP).toBe('Show this one in month view — only one per date.');
  });

  it('announces whether this one is the starred one', () => {
    expect(renderTag(null, 'p-1')).toContain('aria-pressed="false"');
    expect(renderTag({ kind: 'page', id: 'p-1' }, 'p-1')).toContain('aria-pressed="true"');
  });

  it('rings the starred chip, and only that chip', () => {
    const starred = renderTag({ kind: 'page', id: 'p-1' }, 'p-1');
    const other = renderTag({ kind: 'page', id: 'p-1' }, 'p-2');

    expect(starred).toContain('ring-amber-400');
    expect(other).not.toContain('ring-amber-400');
  });

  it('does not answer to a star of another kind holding the same id', () => {
    // Half the star's identity is which picker it is in; ids are uuids, but
    // the kind is what was asserted.
    expect(renderTag({ kind: 'slide', id: 'p-1' }, 'p-1')).toContain('aria-pressed="false"');
  });

  it('marks a draft option and leaves a published one alone', () => {
    expect(renderTag(null, 'p-2')).toContain('Draft');
    expect(renderTag(null, 'p-1')).not.toContain('Draft');
  });

  it('offers its own unlink control, since antd stops drawing one', () => {
    expect(renderTag(null, 'p-1')).toContain('aria-label="Unlink Week 1 reading"');
    expect(renderTag(null, 'p-1', { closable: false })).not.toContain('aria-label="Unlink');
  });

  it('offers the whole title as a tooltip, since the chip truncates', () => {
    expect(renderTag(null, 'p-1')).toContain('title="Week 1 reading"');
  });

  it('never shows a bare id, even for a value nothing names', () => {
    // antd's own label for an option that does not exist IS the raw uuid, which
    // is what used to reach the screen. Reaching this at all takes a link whose
    // resource is in neither the picker nor the event.
    const html = renderTag(null, '0f8f0f6e-1f0e-4b9a-9a1e-0f0e0f0e0f0e');

    expect(html).not.toContain('0f8f0f6e');
    expect(html).toContain(UNNAMED_LINK);
  });
});

describe('titles the event remembers', () => {
  const EVENT = {
    pages: [{ page: { id: 'p-9', title: 'Linked page', is_draft: true } }],
    slides: [{ slide: { id: 's-9', title: 'Linked deck', is_draft: false } }],
    assignments: [
      {
        assignment: { id: 'a-pub', title: 'Published HW', is_published: true },
        repository: { slug: 'hw', is_published: true },
      },
      {
        assignment: { id: 'a-unpub', title: 'Pulled HW', is_published: false },
        repository: { slug: 'hw', is_published: true },
      },
      {
        assignment: { id: 'a-unpub-repo', title: 'HW in a hidden repo', is_published: true },
        repository: { slug: 'hw2', is_published: false },
      },
    ],
  };

  it('names each kind from the event\u2019s own display arrays', () => {
    const meta = eventLinkMeta(EVENT);

    expect(meta.page.get('p-9')).toEqual({ title: 'Linked page', isDraft: true });
    expect(meta.slide.get('s-9')).toEqual({ title: 'Linked deck', isDraft: false });
    expect(meta.assignment.get('a-pub')).toEqual({ title: 'Published HW', isDraft: false });
  });

  it('calls an assignment a draft when EITHER it or its repository is unpublished', () => {
    // The pair the link list marks together: the class cannot see it either way.
    const meta = eventLinkMeta(EVENT);

    expect(meta.assignment.get('a-unpub')?.isDraft).toBe(true);
    expect(meta.assignment.get('a-unpub-repo')?.isDraft).toBe(true);
  });

  it('survives an event that links nothing', () => {
    const meta = eventLinkMeta({});
    expect([meta.page.size, meta.slide.size, meta.assignment.size]).toEqual([0, 0, 0]);
  });

  it('lets a live picker option win over what the event remembers', () => {
    // The picker is the current list; the event is a record of what was linked
    // when. A renamed page should read by its new name.
    const merged = mergeLinkMeta(
      new Map([['p-1', { title: 'Old name', isDraft: true }]]),
      buildLinkOptions(ITEMS).meta
    );

    expect(merged.get('p-1')).toEqual({ title: 'Week 1 reading', isDraft: false });
  });

  it('names a chip the picker does not offer, and marks it a draft', () => {
    // The case seen in the browser: an assignment linked while published and
    // unpublished since. The picker stays published-only, so only the event
    // knows the title.
    const { meta } = buildLinkOptions([{ id: 'a-pub', title: 'Published HW' }]);
    const tagRender = createLinkTagRender({
      kind: 'assignment',
      meta: mergeLinkMeta(eventLinkMeta(EVENT).assignment, meta),
      featured: null,
      onToggleFeatured: vi.fn(),
    });

    const html = renderToStaticMarkup(
      tagRender({ label: 'a-unpub', value: 'a-unpub', closable: true, onClose: vi.fn() })
    );

    expect(html).toContain('Pulled HW');
    expect(html).toContain('Draft');
    expect(html).toContain('aria-label="Show Pulled HW in month view"');
    expect(html).not.toContain('>a-unpub<');
  });
});

describe('a dropdown row', () => {
  it('marks a draft option, so the list says what the picker now offers', () => {
    const html = renderToStaticMarkup(
      <>
        {renderLinkOption({ label: 'Unfinished notes', data: buildLinkOptions(ITEMS).options[1] })}
      </>
    );

    expect(html).toContain('Unfinished notes');
    expect(html).toContain('Draft');
  });

  it('leaves a published option unmarked', () => {
    const html = renderToStaticMarkup(
      <>{renderLinkOption({ label: 'Week 1 reading', data: buildLinkOptions(ITEMS).options[0] })}</>
    );

    expect(html).not.toContain('Draft');
  });
});

describe('what the star becomes when a star is clicked', () => {
  const PAGE: FeaturedRef = { kind: 'page', id: 'p-1' };

  it('moves to the newly starred resource, clearing the old one', () => {
    // One line under the event, so one star: starring a deck un-stars the page
    // without anyone having to un-star it first.
    expect(nextFeatured(PAGE, { kind: 'slide', id: 's-1' })).toEqual({ kind: 'slide', id: 's-1' });
  });

  it('clears when the starred chip is clicked again', () => {
    // The only way back to "show nothing under this event".
    expect(nextFeatured(PAGE, PAGE)).toBeNull();
  });

  it('stars from nothing', () => {
    expect(nextFeatured(null, PAGE)).toEqual(PAGE);
  });

  it('treats the same id under another kind as a different resource', () => {
    expect(nextFeatured(PAGE, { kind: 'slide', id: 'p-1' })).toEqual({ kind: 'slide', id: 'p-1' });
  });
});

describe('what the star becomes when a picker changes', () => {
  const PAGE: FeaturedRef = { kind: 'page', id: 'p-1' };

  it('clears when the starred resource is no longer linked', () => {
    // All three ways of unlinking arrive here: the chip's ×, deselecting in
    // the dropdown, and clearing the whole picker.
    expect(featuredAfterSelection(PAGE, 'page', ['p-2'])).toBeNull();
    expect(featuredAfterSelection(PAGE, 'page', [])).toBeNull();
  });

  it('stays while the starred resource is still linked', () => {
    expect(featuredAfterSelection(PAGE, 'page', ['p-1', 'p-2'])).toEqual(PAGE);
  });

  it('ignores a change in a picker the star is not in', () => {
    // Emptying the decks picker says nothing about a starred page.
    expect(featuredAfterSelection(PAGE, 'slide', [])).toEqual(PAGE);
  });

  it('leaves an empty star alone', () => {
    expect(featuredAfterSelection(null, 'page', [])).toBeNull();
  });
});
