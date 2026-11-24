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

  return h(
    'div',
    { style: { ...BOX_STYLE, ...boxStyle } },
    h('iframe', {
      src: decision.src,
      style: FRAME_STYLE,
      // A PDF is framed unsandboxed (see `decideFrame`); everything else is.
      sandbox: decision.sandboxed ? FRAME_SANDBOX : undefined,
      allow: FRAME_ALLOW,
      allowFullScreen: true,
      referrerPolicy: FRAME_REFERRER_POLICY,
      loading: 'lazy',
      title,
    })
  );
}
