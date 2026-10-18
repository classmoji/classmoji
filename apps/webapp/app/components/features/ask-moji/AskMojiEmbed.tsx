import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRevalidator } from 'react-router';
import { ASK_MOJI_COPY } from '@classmoji/utils/ask-moji';
import { AskMojiProvider } from './AskMojiProvider';
import AskMojiPanel from './AskMojiPanel';
import {
  ASKMOJI_BUSY,
  ASKMOJI_CLOSE,
  ASKMOJI_OPEN,
  ASKMOJI_READY,
  ASKMOJI_REQUEST_CLOSE,
  ASKMOJI_VIEWING,
  readHostMessage,
  type AskMojiFrameMessage,
  type EmbedViewing,
} from './protocol';
import { useEscapeWithin } from './useEscapeWithin';
import './styles.css';

export type AskMojiEmbedData =
  | {
      state: 'ready';
      parentOrigin: string | null;
      classroomSlug: string;
      courseName: string;
      pagesUrl: string | null;
      slidesUrl: string | null;
    }
  | { state: 'signed-out'; parentOrigin: string | null; signInUrl: string }
  | { state: 'unavailable'; parentOrigin: string | null; line: string; staffLine: string | null };

/**
 * The panel inside the pages/slides frame. Talks to its host only through
 * ./protocol.ts: the listener goes in first, then `ready`; every host message
 * is checked for the parent origin the route verified and the parent window.
 * With no verified parent origin nothing is posted and nothing believed.
 *
 * The host's open/close (not the frame's own visibility: the host hides its
 * container, which leaves this document "visible") start and stop the poll.
 * Every state, signed-out and unavailable included, has a close control that
 * asks the host to close.
 */
export default function AskMojiEmbed({ data }: { data: AskMojiEmbedData }) {
  const parentOrigin = data.parentOrigin;
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<EmbedViewing | null>(null);
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;
  const stateRef = useRef(data.state);
  stateRef.current = data.state;
  // Client only (the chat lives in the browser), and whether a host frames us.
  const [client, setClient] = useState<{ framed: boolean } | null>(null);
  useEffect(() => setClient({ framed: window.parent !== window }), []);

  const post = useCallback(
    (message: AskMojiFrameMessage) => {
      if (!parentOrigin || window.parent === window) return;
      window.parent.postMessage(message, parentOrigin);
    },
    [parentOrigin]
  );

  useEffect(() => {
    if (!parentOrigin || window.parent === window) return undefined;
    const onMessage = (event: MessageEvent) => {
      const message = readHostMessage(event, { parentOrigin, parentWindow: window.parent });
      if (!message) return;
      if (message.type === ASKMOJI_VIEWING) setViewing(message.viewing);
      else if (message.type === ASKMOJI_OPEN) {
        setOpen(true);
        // Signed in elsewhere since: look again.
        if (stateRef.current === 'signed-out') revalidateRef.current();
      } else if (message.type === ASKMOJI_CLOSE) setOpen(false);
    };
    window.addEventListener('message', onMessage);
    post({ type: ASKMOJI_READY });
    return () => window.removeEventListener('message', onMessage);
  }, [parentOrigin, post]);

  const requestClose = useCallback(() => post({ type: ASKMOJI_REQUEST_CLOSE }), [post]);
  const lastBusy = useRef<boolean | null>(null);
  const onBusyChange = useCallback(
    (busy: boolean) => {
      if (lastBusy.current === busy) return;
      lastBusy.current = busy;
      post({ type: ASKMOJI_BUSY, busy });
    },
    [post]
  );

  if (data.state !== 'ready') {
    return (
      <EmbedShell onClose={requestClose}>
        {data.state === 'signed-out' ? (
          <div className="moji-state">
            <div className="moji-state-line">Sign in to Classmoji to ask Moji.</div>
            <a
              className="moji-button"
              href={data.signInUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Sign in
            </a>
          </div>
        ) : (
          <div className="moji-state">
            <div className="moji-state-line">{data.line}</div>
            {data.staffLine && <div className="moji-state-sub">{data.staffLine}</div>}
          </div>
        )}
      </EmbedShell>
    );
  }

  if (!client || (client.framed && !parentOrigin)) {
    // Before hydration, or framed by a host we could not verify: nothing to talk to.
    return (
      <EmbedShell onClose={requestClose}>
        {client ? (
          <div className="moji-state">
            <div className="moji-state-line">{ASK_MOJI_COPY.UNAVAILABLE}</div>
          </div>
        ) : null}
      </EmbedShell>
    );
  }

  return (
    <AskMojiProvider classroomSlug={data.classroomSlug} viewAs={null}>
      <AskMojiPanel
        mode="embed"
        // Opened on its own (not framed): open. Framed: the host decides.
        open={client.framed ? open : true}
        onRequestClose={requestClose}
        courseName={data.courseName}
        classroomSlug={data.classroomSlug}
        pagesUrl={data.pagesUrl}
        slidesUrl={data.slidesUrl}
        viewing={viewing}
        onBusyChange={onBusyChange}
      />
    </AskMojiProvider>
  );
}

/** The frame's chrome for states with no conversation: a title and a close control. */
function EmbedShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeWithin(ref, onClose);
  return (
    <div
      ref={ref}
      className="moji-panel"
      data-mode="embed"
      data-state="open"
      role="dialog"
      aria-label="Ask Moji"
    >
      <div className="moji-header">
        <div className="moji-dots">
          <button
            type="button"
            className="moji-dot-btn moji-dot-btn--close moji-dot-btn--shown"
            onClick={onClose}
            aria-label="Close Ask Moji"
            title="Close"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="1" y1="1" x2="7" y2="7" />
              <line x1="7" y1="1" x2="1" y2="7" />
            </svg>
          </button>
        </div>
        <div className="moji-title">
          <span className="moji-title-name">Ask Moji</span>
        </div>
      </div>
      <div className="moji-body">{children}</div>
    </div>
  );
}
