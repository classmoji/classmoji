import { createElement, type CSSProperties } from 'react';

import {
  FRAME_ALLOW,
  FRAME_REFERRER_POLICY,
  FRAME_SANDBOX,
  type FrameDecision,
} from './safeFrame.ts';

/**
 * Written with `createElement` in a `.ts` file rather than JSX, so the unit
 * suite can render it: Playwright's test transform rewrites JSX in app files
 * into component-test descriptors that React refuses to render.
 */
const h = createElement;

/** A 16:9 box the frame fills, as the embed and video blocks have always drawn it. */
const BOX_STYLE: CSSProperties = {
  position: 'relative',
  paddingBottom: '56.25%',
  height: 0,
  overflow: 'hidden',
  borderRadius: '0.5rem',
};

const FRAME_STYLE: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  border: 'none',
};

export interface SafeFrameProps {
  decision: FrameDecision;
  title: string;
  editable: boolean;
  storedUrl: string;
  boxStyle?: CSSProperties;
}

/** A document glyph for the file card (decorative). */
function FileGlyph() {
  return h(
    'svg',
    {
      className: 'bn-frame-file-icon',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.75,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }),
    h('path', { d: 'M14 3v5h5' }),
    h('path', { d: 'M9 13h6M9 17h4' })
  );
}

/**
 * A host as the card shows it: the last two labels (and any port) in `tail`,
 * which is never cut, and the rest in `head`, which is cut first when there
 * is no room. So the end of a long host, where its registrable domain is,
 * always shows: `docs.google.com.aaaa….attacker.example` keeps
 * `attacker.example`.
 */
export function splitHostForCard(host: string): { head: string; tail: string } {
  const [name, port] = host.split(/(?=:\d+$)/);
  const labels = name.split('.');
  if (labels.length <= 2) return { head: '', tail: host };
  return {
    head: `${labels.slice(0, -2).join('.')}.`,
    tail: `${labels.slice(-2).join('.')}${port ?? ''}`,
  };
}

/**
 * A PDF that is not framed (`FrameDecision.file`): a card naming the file and
 * the host it is on, with an "Open" link that opens it in a new tab. One
 * markup in the editor and the reader, so an author sees what readers get. In
 * the reader the whole card is that link's hit area (`bn-frame-file-reader`,
 * a stretched `::after`); in the editor only "Open" is a link, so a click
 * that selects the block opens nothing.
 */
function FileCard({
  decision,
  editable,
}: {
  decision: Extract<FrameDecision, { kind: 'file' }>;
  editable: boolean;
}) {
  const host = splitHostForCard(decision.host);
  return h(
    'div',
    { className: editable ? 'bn-frame-file' : 'bn-frame-file bn-frame-file-reader' },
    h(FileGlyph),
    h(
      'span',
      { className: 'bn-frame-file-text' },
      h('span', { className: 'bn-frame-file-name' }, decision.name),
      h(
        'span',
        { className: 'bn-frame-file-host', title: decision.host },
        host.head ? h('span', { className: 'bn-frame-file-host-head' }, host.head) : null,
        h('span', { className: 'bn-frame-file-host-tail' }, host.tail)
      )
    ),
    h(
      'a',
      {
        className: 'bn-frame-file-open',
        href: decision.href,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': `Open ${decision.name} (${decision.host}) in a new tab`,
      },
      'Open'
    )
  );
}

/**
 * The one way a page block frames another site (`safeFrame.ts` decides what).
 *
 * `none` draws nothing for a reader; an author still sees what they stored,
 * as text, so the block they placed does not vanish from under them.
 */
export function SafeFrame({ decision, title, editable, storedUrl, boxStyle }: SafeFrameProps) {
  if (decision.kind === 'none') {
    return editable && storedUrl
      ? h('p', { className: 'bn-frame-fallback bn-frame-unavailable' }, storedUrl)
      : null;
  }

  if (decision.kind === 'link') {
    return h(
      'p',
      { className: 'bn-frame-fallback' },
      decision.href
        ? h(
            'a',
            { href: decision.href, target: '_blank', rel: 'noopener noreferrer' },
            decision.text
          )
        : h('span', null, decision.text)
    );
  }

  if (decision.kind === 'file') return h(FileCard, { decision, editable });

  return h(
    'div',
    { style: { ...BOX_STYLE, ...boxStyle } },
    h('iframe', {
      src: decision.src,
      style: FRAME_STYLE,
      // Only a PDF of the class's own is framed unsandboxed (see `decideFrame`).
      sandbox: decision.sandboxed ? FRAME_SANDBOX : undefined,
      allow: FRAME_ALLOW,
      allowFullScreen: true,
      referrerPolicy: FRAME_REFERRER_POLICY,
      loading: 'lazy',
      title,
    })
  );
}
