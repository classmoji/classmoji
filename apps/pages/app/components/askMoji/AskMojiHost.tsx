import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  ASKMOJI_ATTR,
  ASKMOJI_BUSY,
  ASKMOJI_CLOSE,
  ASKMOJI_OPEN,
  ASKMOJI_READY,
  ASKMOJI_REQUEST_CLOSE,
  askMojiEmbedUrl,
  readAskMojiMessage,
  syncMessages,
  viewingMessage,
  type AskMojiHostMessage,
  type AskMojiViewing,
} from './askMojiProtocol.ts';

import './askMoji.css';

interface AskMojiHostProps {
  /** The webapp origin, from the loader (`askMojiOrigin`). */
  webappOrigin: string;
  classroomSlug: string;
  viewing: AskMojiViewing;
  /** The page's title (loader data), for the frame's chip only. */
  title?: string;
  /** Extra classes for the launcher (its placement). */
  launcherClassName?: string;
  /** Hide the launcher (another overlay owns the screen); the frame stays. */
  launcherHidden?: boolean;
}

/**
 * The Ask Moji launcher plus the fixed container holding the webapp's panel.
 *
 * The frame is created on first open and then kept: closing hides the
 * container, it never unmounts or reloads the frame, so a running answer keeps
 * running. Render this from a component that stays mounted across in-app
 * navigation (the classroom layout), and only when the loader said
 * `askMojiEnabled`. The protocol is in ./askMojiProtocol.ts.
 *
 * Keyed on origin + classroom: moving to another classroom is a new panel.
 */
export default function AskMojiHost(props: AskMojiHostProps) {
  return <AskMojiHostInner key={`${props.webappOrigin}|${props.classroomSlug}`} {...props} />;
}

function AskMojiHostInner({
  webappOrigin,
  classroomSlug,
  viewing,
  title,
  launcherClassName = '',
  launcherHidden = false,
}: AskMojiHostProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  // The frame's src, fixed at first open; null until then.
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Set once the frame says it is listening; nothing is posted before that.
  const readyRef = useRef(false);
  const latest = useRef({ viewing, title, open });
  latest.current = { viewing, title, open };

  // Client only (the server render has no document), and never inside a
  // frame: a framed copy of this screen (an embed on a page, the webapp's own
  // reader) must not open a second panel.
  useEffect(() => {
    if (window.self === window.top) setPortalTarget(document.body);
  }, []);

  const post = useCallback(
    (message: AskMojiHostMessage) => {
      const target = frameRef.current?.contentWindow;
      if (!target || !readyRef.current) return;
      target.postMessage(message, webappOrigin);
    },
    [webappOrigin]
  );

  const close = useCallback(() => {
    setOpen(false);
    // Focus was in the panel: hand it back to the launcher, not to <body>.
    const active = document.activeElement;
    if (active && containerRef.current?.contains(active)) {
      launcherRef.current?.focus();
    }
  }, []);

  const toggle = useCallback(() => {
    if (latest.current.open) {
      close();
      return;
    }
    setFrameSrc(src => src ?? askMojiEmbedUrl(webappOrigin, classroomSlug, window.location.origin));
    setOpen(true);
  }, [close, webappOrigin, classroomSlug]);

  // Frame → host. Origin, source frame and shape are all checked.
  useEffect(() => {
    if (!frameSrc) return;
    const onMessage = (event: MessageEvent) => {
      const message = readAskMojiMessage(event, {
        webappOrigin,
        frameWindow: frameRef.current?.contentWindow ?? null,
      });
      if (!message) return;
      if (message.type === ASKMOJI_READY) {
        readyRef.current = true;
        const { viewing: v, open: o, title: t } = latest.current;
        for (const sync of syncMessages(v, o, t)) post(sync);
      } else if (message.type === ASKMOJI_REQUEST_CLOSE) {
        close();
      } else if (message.type === ASKMOJI_BUSY) {
        setBusy(message.busy);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameSrc, webappOrigin, post, close]);

  // Host → frame: the viewing (and its title), whenever either changes.
  const viewingKey = viewing ? `${viewing.kind}:${viewing.id}:${title ?? ''}` : '';
  useEffect(() => {
    post(viewingMessage(latest.current.viewing, latest.current.title));
  }, [viewingKey, post]);

  // Host → frame: open/close. Before `ready` this is a no-op; `ready` resends it.
  useEffect(() => {
    post({ type: open ? ASKMOJI_OPEN : ASKMOJI_CLOSE });
    if (open) frameRef.current?.focus();
  }, [open, post]);

  // Escape in this document closes the panel, unless something else already
  // handled it. preventDefault so nothing further up acts on it too.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const askMojiAttr = { [ASKMOJI_ATTR]: '' };

  return (
    <>
      {portalTarget && !launcherHidden && (
        <button
          ref={launcherRef}
          type="button"
          {...askMojiAttr}
          className={`askmoji-launcher ${launcherClassName}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          Ask Moji
          {busy && <span className="askmoji-launcher-dot" aria-hidden="true" />}
        </button>
      )}
      {portalTarget &&
        createPortal(
          <div
            ref={containerRef}
            id={panelId}
            {...askMojiAttr}
            className={`askmoji-panel ${open ? 'askmoji-panel-open' : ''}`}
            role="dialog"
            aria-label="Ask Moji"
            aria-hidden={!open}
          >
            {frameSrc && (
              <iframe
                ref={frameRef}
                src={frameSrc}
                title="Ask Moji"
                allow="clipboard-write"
                className="askmoji-frame"
              />
            )}
          </div>,
          portalTarget
        )}
    </>
  );
}
