import React from 'react';
import { BlockNoteSchema } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';

import { schema as editorSchema } from '~/components/editor/blocks/index.tsx';
import { AVATAR_SIZES, imageSizesFor, responsiveImageAttrs } from '~/utils/imageSizes.ts';
import {
  navGridEntryEmoji,
  navGridEntryLabel,
  normalizeNavGridColumns,
  parseNavGridEntries,
  NAV_GRID_SCHEDULE_PATH,
} from '~/components/editor/blocks/navGridShared.ts';

/**
 * The BlockNote schema class websites render with.
 *
 * It is the editor's schema with every interactive block replaced by a static
 * one. Three separate reasons force this, and any one of them alone would be
 * enough:
 *
 *  1. **Editor affordances must not ship.** A class-site page has no
 *     JavaScript, so the editor's `<input>`s, upload buttons and language
 *     `<select>`s would render as dead controls that look clickable. The
 *     Profile block's whole populated state is two text inputs; the Video and
 *     Embed blocks' empty state is a URL box.
 *
 *  2. **Some editor renders do not survive the server at all.** `pageLink`
 *     calls `useNavigate()` at the top of its render — outside a Router that
 *     throws, and BlockNote swallows the failure into an empty `<span>`, so a
 *     page full of page links would silently render as a page full of nothing.
 *     `toggleListItem` (BlockNote's own) reads `localStorage`, which throws
 *     `SecurityError: localStorage is not available for opaque origins` inside
 *     the server's JSDOM and takes down the ENTIRE document render, not just
 *     that block. Both are verified in `tests/unit/site-render.spec.ts`.
 *
 *  3. **Visibility is per-viewer.** `pageLink` and `navGrid` name other pages;
 *     which of those an anonymous visitor may even see the TITLE of is a
 *     decision only the request knows. That is why this module exports a
 *     schema *factory* keyed on a link resolver rather than a constant.
 *
 * Every static render is written with `React.createElement` in a `.ts` file
 * rather than JSX in a `.tsx` one. That is not stylistic: Playwright's test
 * transform rewrites JSX in app files into its own component-test descriptors
 * (`{__pw_type, ...}`), which React refuses to render — so JSX here would make
 * the renderer untestable in the repo's unit-test harness.
 */

const h = React.createElement;

/** Protocols an embedded frame or media element may load from. */
const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * The sandbox a class site grants embedded third-party frames.
 *
 * `allow-top-navigation` is deliberately absent: with it, any embed an
 * instructor pasted — or anything that later appears at that URL — could
 * navigate the whole tab somewhere else, which is a phishing primitive
 * pointed at a class's students.
 */
const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-presentation';
const FRAME_ALLOW = 'encrypted-media; picture-in-picture; fullscreen';

/** A plain, safe link — the fallback whenever a URL cannot be embedded. */
function plainLink(url: string, label?: string) {
  return h(
    'a',
    { href: url, rel: 'noopener noreferrer', className: 'bn-site-fallback-link' },
    label || url
  );
}

/** YouTube/Vimeo watch URLs → their embeddable equivalents. */
function toEmbedUrl(url: string): string {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return url;
}

const isDirectVideo = (url: string): boolean => /\.(mp4|webm|ogg)(\?|$)/i.test(url);

/** A 16:9 responsive frame wrapper, matching the editor's populated state. */
function frameBox(child: React.ReactNode) {
  return h(
    'div',
    {
      className: 'bn-site-frame',
      style: { position: 'relative', paddingBottom: '56.25%', height: 0, overflow: 'hidden' },
    },
    child
  );
}

const FRAME_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  border: 'none',
};

/* ------------------------------------------------------------------ *
 * Per-viewer link resolution
 * ------------------------------------------------------------------ */

/**
 * What the renderer knows about a page another block links to.
 *
 * `membersOnly` is not a secret: a resolver returns a link at all only for a
 * page THIS viewer may open, so it can only ever be true for someone who is
 * already a member. It exists so a directory can mark the entries a signed-out
 * classmate would not be able to follow.
 */
export type SitePageLink = { href: string; title: string; membersOnly?: boolean };

/**
 * Resolves a page id to a link this viewer may follow, or `null`.
 *
 * `null` means "drop it entirely" — not "render it greyed out". An anonymous
 * visitor must not learn that a members-only page called "Exam 2 Solutions"
 * exists; a disabled-looking entry with its title still on screen leaks
 * exactly the thing the visibility rule protects.
 */
export type PageLinkResolver = (pageId: string) => SitePageLink | null;

/**
 * `{ signedUrl: srcset }` for the images on this page.
 *
 * Keyed by the SIGNED url, not the stored reference — the site rewrites a
 * document's references to signed URLs before rendering it, so by the time a
 * block render sees `props.url` it is already the signed one. (The editor is
 * the opposite: its blocks keep the stored reference and the display URL rides
 * beside them, so its map is keyed by the reference.)
 */
export type SiteSrcSets = Record<string, string>;

/* ------------------------------------------------------------------ *
 * Static block implementations
 * ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any -- BlockNote's per-spec
   render prop types are generated from each config; the static renders below
   only read `block.props`, and re-deriving 10 generic signatures would add no
   safety over the runtime `parse*` helpers each one already uses. */
type RenderProps = any;

function StaticCallout(props: RenderProps) {
  const emoji = String(props.block.props.emoji || '💡');
  return h('div', { className: 'callout-block' }, [
    h('div', { key: 'e', className: 'callout-emoji', style: { fontSize: '1.5rem' } }, emoji),
    h('div', { key: 'c', className: 'inline-content', ref: props.contentRef, style: { flex: 1 } }),
  ]);
}

function StaticTerminal(props: RenderProps) {
  const code = String(props.block.props.code || '');
  const title = String(props.block.props.title || '');
  return h('div', { className: 'terminal-block' }, [
    h('div', { key: 'h', className: 'terminal-header' }, [
      h('div', { key: 'd', className: 'terminal-dots' }, [
        h('span', { key: 'r', className: 'dot dot-red' }),
        h('span', { key: 'y', className: 'dot dot-yellow' }),
        h('span', { key: 'g', className: 'dot dot-green' }),
      ]),
      h('span', { key: 't', className: 'terminal-title' }, title || 'Terminal'),
    ]),
    // No Shiki on the server in v1: the highlighter is an async browser-side
    // effect, and pre-rendering it would mean shipping a theme stylesheet for
    // a purely decorative win. Plain <pre><code> reads correctly either way.
    h(
      'div',
      { key: 'c', className: 'terminal-content' },
      h('pre', null, h('code', { className: 'language-bash' }, code))
    ),
  ]);
}

/**
 * Responsive candidates for one already-rewritten reference.
 *
 * The block's `url` prop has ALREADY been swapped for the signed URL by the
 * site's document rewrite before it reaches a render, so the lookup here is
 * keyed by the signed URL — the opposite of the editor, where the block still
 * holds the stored reference. `SiteSrcSets` is built to match; see
 * `siteSrcSetsBySignedUrl`.
 *
 * `srcSet` and `sizes` are returned together or not at all: a `srcSet` with no
 * `sizes` makes the browser assume the image fills the viewport and fetch the
 * widest rung, which is worse than shipping no candidates.
 */
function responsiveAttrs(srcSets: SiteSrcSets, url: string, sizes: string) {
  return responsiveImageAttrs(srcSets, url, sizes);
}

function makeStaticProfile(srcSets: SiteSrcSets) {
  return function StaticProfile(props: RenderProps) {
    const name = String(props.block.props.name || '');
    const title = String(props.block.props.title || '');
    const imageUrl = String(props.block.props.imageUrl || '');

    return h('div', { className: 'profile-block' }, [
      h(
        'div',
        { key: 'a', className: 'profile-avatar-wrapper' },
        imageUrl
          ? h('img', {
              src: imageUrl,
              // A fixed 64px circle. Saying so is the whole point: it is what
              // makes the browser take the smallest rung rather than a 2560px
              // rendition of an instructor's camera JPEG.
              ...responsiveAttrs(srcSets, imageUrl, AVATAR_SIZES),
              alt: name || 'Profile image',
              className: 'profile-avatar-image',
              loading: 'lazy',
            })
          : h('div', { className: 'profile-avatar-placeholder' }, '👤')
      ),
      h('div', { key: 't', style: { flex: 1, minWidth: 0 } }, [
        name ? h('div', { key: 'n', className: 'profile-display-name' }, name) : null,
        title ? h('div', { key: 'r', className: 'profile-display-title' }, title) : null,
      ]),
    ]);
  };
}

/**
 * The image block, statically.
 *
 * It has to be overridden here for the same reason `toggleListItem` does: the
 * editor's image block is built on BlockNote's `ResizableFileBlockWrapper`,
 * which needs editor context the server render does not provide — it throws,
 * BlockNote swallows the throw, and the block renders as NOTHING. Verified by
 * the block-coverage test in tests/unit/site-render.spec.ts.
 *
 * Rendering it here rather than post-processing the HTML also means `sizes` can
 * be computed from the block's own `previewWidth`, which is the only place that
 * number exists. An image the author resized to 400px says so, and stops
 * fetching a 2560px rendition to paint 400 pixels.
 */
function makeStaticImage(srcSets: SiteSrcSets) {
  return function StaticImage(props: RenderProps) {
    const url = String(props.block.props.url || '');
    if (!url) return h('div', { className: 'bn-site-empty' });

    const caption = String(props.block.props.caption || '');
    const name = String(props.block.props.name || '');
    const rawWidth = props.block.props.previewWidth;
    const previewWidth = typeof rawWidth === 'number' ? rawWidth : null;

    // `showPreview: false` is the author asking for a download link, not a
    // picture — the same choice BlockNote's own block honours.
    if (props.block.props.showPreview === false) {
      return h('div', { className: 'bn-file-block-content-wrapper' }, [
        h(
          'div',
          { key: 'f', className: 'bn-file-name-with-icon' },
          h('p', { className: 'bn-file-name' }, name || caption || url)
        ),
        caption ? h('p', { key: 'c', className: 'bn-file-caption' }, caption) : null,
      ]);
    }

    return h(
      'div',
      {
        className: 'bn-file-block-content-wrapper',
        // BlockNote's own wrapper sets the resized width inline; matching it is
        // what keeps a resized image the same size on the site as in the editor.
        style: previewWidth ? { width: `${previewWidth}px` } : undefined,
      },
      [
        h('img', {
          key: 'i',
          className: 'bn-visual-media',
          src: url,
          ...responsiveAttrs(srcSets, url, imageSizesFor(previewWidth)),
          alt: caption || name || 'Image',
          loading: 'lazy',
        }),
        caption ? h('p', { key: 'c', className: 'bn-file-caption' }, caption) : null,
      ]
    );
  };
}

function StaticDivider() {
  return h('div', { className: 'divider-block' }, h('hr', null));
}

function StaticEmbed(props: RenderProps) {
  const url = String(props.block.props.url || '');
  if (!url) return h('div', { className: 'bn-site-empty' });
  // http:// and everything exotic degrades to a link rather than a frame: a
  // mixed-content iframe is blocked by the browser anyway, so the "embed"
  // would be an empty box where the author expected content.
  if (!isHttpsUrl(url)) return plainLink(url);

  return frameBox(
    h('iframe', {
      src: url,
      title: 'Embedded content',
      style: FRAME_STYLE,
      sandbox: FRAME_SANDBOX,
      allow: FRAME_ALLOW,
      referrerPolicy: 'no-referrer',
      loading: 'lazy',
    })
  );
}

function StaticVideo(props: RenderProps) {
  const url = String(props.block.props.url || '');
  const caption = String(props.block.props.caption || '');
  const captionNode = caption
    ? h('p', { key: 'cap', className: 'media-block-caption-view' }, caption)
    : null;

  if (!url) return h('div', { className: 'bn-site-empty' });
  if (!isHttpsUrl(url)) return h('div', null, [plainLink(url), captionNode]);

  const media = isDirectVideo(url)
    ? h('video', {
        key: 'v',
        src: url,
        controls: true,
        preload: 'metadata',
        style: { width: '100%', borderRadius: '0.5rem' },
      })
    : frameBox(
        h('iframe', {
          src: toEmbedUrl(url),
          title: caption || 'Video',
          style: FRAME_STYLE,
          sandbox: FRAME_SANDBOX,
          allow: FRAME_ALLOW,
          referrerPolicy: 'no-referrer',
          loading: 'lazy',
        })
      );

  return h('div', null, [h('div', { key: 'm' }, media), captionNode]);
}

function makeStaticPageLink(resolve: PageLinkResolver) {
  return function StaticPageLink(props: RenderProps) {
    const pageId = String(props.block.props.pageId || '');
    const storedTitle = String(props.block.props.pageTitle || '');
    const link = pageId ? resolve(pageId) : null;

    // Unresolvable = deleted, draft, or not visible to this viewer. All three
    // render as nothing: the denormalized title in the block props is a stale
    // copy we must not print on the visitor's behalf.
    if (!link) return h('div', { className: 'bn-site-empty' });

    return h(
      'div',
      { className: 'page-link-display' },
      h(
        'a',
        { href: link.href, className: 'page-link-title' },
        link.title || storedTitle || 'Untitled'
      )
    );
  };
}

function makeStaticNavGrid(resolve: PageLinkResolver, showSchedule: boolean) {
  return function StaticNavGrid(props: RenderProps) {
    const entries = parseNavGridEntries(props.block.props.entries);
    const columns = normalizeNavGridColumns(props.block.props.columns);

    // ALWAYS emitted, empty or not: the slot is a fixed-width column inside the
    // tile, so an emoji on one entry and none on the next used to pull that
    // tile's label left and leave a two-column grid visibly misaligned.
    const emojiSlot = (emoji: string | undefined) =>
      h('span', { key: 'e', className: 'bn-nav-grid-emoji', 'aria-hidden': 'true' }, emoji || '');

    const children: React.ReactNode[] = [];
    entries.forEach((entry, index) => {
      if (entry.kind === 'page') {
        const link = resolve(entry.pageId);
        if (!link) return; // dropped entirely — see PageLinkResolver
        children.push(
          h(
            'a',
            {
              key: `page-${entry.pageId}-${index}`,
              className: 'bn-nav-grid-item',
              'data-kind': 'page',
              href: link.href,
            },
            [
              emojiSlot(entry.emoji),
              h(
                'span',
                { key: 'l', className: 'bn-nav-grid-label' },
                // The authored label wins over the live page title: the
                // instructor may have renamed the entry on purpose.
                entry.title || link.title || 'Untitled'
              ),
              // Reachable only by a viewer who could already open the page —
              // an anonymous visitor never resolved this entry at all — so it
              // marks a link their signed-out classmates cannot follow rather
              // than announcing that a hidden page exists.
              link.membersOnly
                ? h('span', { key: 'm', className: 'bn-nav-grid-badge' }, 'Members')
                : null,
            ]
          )
        );
        return;
      }

      if (entry.kind === 'schedule') {
        // Dropped exactly the way an invisible page is: the schedule route
        // 404s when `show_schedule` is off, so rendering the tile anyway would
        // be a link into a wall. Silently absent, never disabled-looking.
        if (!showSchedule) return;
        children.push(
          h(
            'a',
            {
              key: `schedule-${index}`,
              className: 'bn-nav-grid-item',
              'data-kind': 'schedule',
              href: NAV_GRID_SCHEDULE_PATH,
            },
            [
              emojiSlot(navGridEntryEmoji(entry)),
              h('span', { key: 'l', className: 'bn-nav-grid-label' }, navGridEntryLabel(entry)),
            ]
          )
        );
        return;
      }

      children.push(
        h(
          'a',
          {
            key: `external-${index}`,
            className: 'bn-nav-grid-item',
            'data-kind': 'external',
            href: entry.url,
            rel: 'noopener noreferrer',
          },
          [
            emojiSlot(entry.emoji),
            h('span', { key: 'l', className: 'bn-nav-grid-label' }, navGridEntryLabel(entry)),
            h('span', { key: 'x', className: 'bn-nav-grid-ext', 'aria-hidden': 'true' }, '↗'),
          ]
        )
      );
    });

    return h(
      'nav',
      {
        className: 'bn-nav-grid nav-grid',
        'data-columns': columns,
        style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
      },
      children
    );
  };
}

function StaticCodeBlock(props: RenderProps) {
  // BlockNote's own code block renders a language `<select>` above the code —
  // an editor control that is inert (and confusing) on a static page.
  const language = String(props.block.props.language || '');
  return h(
    'pre',
    { 'data-language': language || undefined },
    h('code', { className: 'bn-inline-content', ref: props.contentRef })
  );
}

function StaticToggleListItem(props: RenderProps) {
  // Rendered expanded. BlockNote keeps a toggle's children in a sibling
  // block-group rather than inside this element, so a real <details> here
  // would collapse the marker and leave the children visible below it —
  // worse than not collapsing at all. Expanded is the honest static form.
  return h('div', { className: 'bn-site-toggle' }, [
    h('span', { key: 'm', className: 'bn-site-toggle-marker', 'aria-hidden': 'true' }, '▾'),
    h('p', { key: 'c', className: 'bn-inline-content', ref: props.contentRef }),
  ]);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ *
 * Schema assembly
 * ------------------------------------------------------------------ */

/** Block types this module replaces with a static, viewer-safe render. */
export const OVERRIDDEN_BLOCK_TYPES = [
  'image',
  'callout',
  'terminal',
  'profile',
  'divider',
  'embed',
  'video',
  'pageLink',
  'navGrid',
  'codeBlock',
  'toggleListItem',
] as const;

type OverriddenBlockType = (typeof OVERRIDDEN_BLOCK_TYPES)[number];

/**
 * Rebuild one spec with a static implementation, reusing the ORIGINAL config.
 *
 * Reusing `config` (type, propSchema, content) rather than re-declaring it is
 * what keeps this file from silently diverging when a block gains a prop —
 * a re-typed propSchema would drop the new prop's default and parse authored
 * content as if it were never set.
 */
function staticSpec(type: OverriddenBlockType, render: (props: never) => React.ReactNode) {
  const original = (editorSchema.blockSpecs as Record<string, { config: unknown }>)[type];
  if (!original) throw new Error(`[site] Cannot override unknown block type: ${type}`);
  // NOTE the trailing call: `createReactBlockSpec` returns a spec FACTORY, not
  // a spec (which is why the editor's schema reads `terminal: Terminal()`).
  // Handing the factory itself to BlockNoteSchema.create fails later and
  // opaquely, as `Cannot read properties of undefined (reading 'node')`.
  return createReactBlockSpec(
    original.config as Parameters<typeof createReactBlockSpec>[0],
    // Both hooks point at the same component: `blocksToFullHTML` (what the
    // site renders with) calls `render`, while `toExternalHTML` is used by
    // copy/paste and export. They must not disagree about what a block is.
    { render, toExternalHTML: render } as Parameters<typeof createReactBlockSpec>[1]
  )();
}

/**
 * Build the viewer schema for one request.
 *
 * Per-request because `pageLink` and `navGrid` bake the viewer's visibility
 * decisions into their markup — there is no such thing as a shared "viewer
 * schema" once anonymous and member visitors must see different link sets.
 *
 * `showSchedule` is the site's own setting rather than a viewer's: a schedule
 * entry in a directory is a link to `/schedule`, and that route 404s for
 * everyone when the instructor has not published it.
 */
export function createViewerSchema(
  resolveLink: PageLinkResolver,
  options: { showSchedule?: boolean; srcSets?: SiteSrcSets } = {}
) {
  const showSchedule = options.showSchedule === true;
  const srcSets = options.srcSets ?? {};

  const blockSpecs = {
    ...editorSchema.blockSpecs,
    image: staticSpec('image', makeStaticImage(srcSets)),
    callout: staticSpec('callout', StaticCallout),
    terminal: staticSpec('terminal', StaticTerminal),
    profile: staticSpec('profile', makeStaticProfile(srcSets)),
    divider: staticSpec('divider', StaticDivider),
    embed: staticSpec('embed', StaticEmbed),
    video: staticSpec('video', StaticVideo),
    pageLink: staticSpec('pageLink', makeStaticPageLink(resolveLink)),
    navGrid: staticSpec('navGrid', makeStaticNavGrid(resolveLink, showSchedule)),
    codeBlock: staticSpec('codeBlock', StaticCodeBlock),
    toggleListItem: staticSpec('toggleListItem', StaticToggleListItem),
  };

  // The override map is heterogeneous by construction — each replaced spec is
  // rebuilt from its original config, so its static type no longer matches the
  // generic BlockNoteSchema.create expects. BlockNoteSchema re-derives the
  // block types from these specs at runtime, which is what actually matters;
  // the coverage test in tests/unit/site-render.spec.ts is what guards it.
  type SchemaOptions = NonNullable<Parameters<typeof BlockNoteSchema.create>[0]>;
  return BlockNoteSchema.create({
    blockSpecs: blockSpecs as SchemaOptions['blockSpecs'],
  });
}

/** Every block type the site can encounter — used by the coverage test. */
export function allBlockTypes(): string[] {
  return Object.keys(editorSchema.blockSpecs).sort();
}
