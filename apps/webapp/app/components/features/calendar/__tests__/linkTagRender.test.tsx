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
  featuredAfterSelection,
  FEATURED_TOOLTIP,
  nextFeatured,
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

  it('leaves the overflow tag as plain text', () => {
    // "+2" stands for several links rather than naming one, so there is
    // nothing on it to star or unlink.
    const html = renderTag(null, 'p-1', { isMaxTag: true, label: '+ 2 ...' });

    expect(html).toContain('+ 2 ...');
    expect(html).not.toContain('<button');
  });

  it('falls back to the value when nothing is known about the option', () => {
    // The wart this replaced: a linked draft the picker did not offer showed
    // as a bare uuid. It still cannot show a title it was never given, but the
    // label antd passes is used before the id is.
    const html = renderTag(null, 'p-missing', { label: 'A title from somewhere' });

    expect(html).toContain('A title from somewhere');
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
