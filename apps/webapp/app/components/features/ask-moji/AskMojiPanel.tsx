import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useChat } from '@ai-sdk/react';
import type { Chat } from '@ai-sdk/react';
import { IconArrowDown, IconChevronRight, IconMessagePlus } from '@tabler/icons-react';
import { ASK_MOJI_COPY, ASK_MOJI_STARTING, type AskMojiUIMessage } from '@classmoji/utils/ask-moji';
import AskMojiMessageView, { type ChipContext } from './AskMojiMessage';
import Composer, { type ComposerHandle } from './Composer';
import { useAskMojiController, useAskMojiSnapshot } from './AskMojiProvider';
import { viewingKey, wireViewing } from './machine';
import { viewingLabel } from './viewing';
import { useEscapeWithin } from './useEscapeWithin';
import type { AskMojiRating } from './api';
import type { AskMojiSnapshot } from './controller';
import type { AskMojiViewingInput } from './viewing';
import './styles.css';

type PanelState = 'opening' | 'open' | 'closed';

/** Where the genie animation starts: the sidebar button. */
function genieOffset(panel: HTMLElement | null) {
  const trigger = document.querySelector('[data-askmoji-trigger]');
  if (!trigger || !panel) return { x: -300, y: 120 };
  const tr = trigger.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  return {
    x: tr.left + tr.width / 2 - (pr.left + pr.width / 2),
    y: tr.top + tr.height / 2 - (pr.top + pr.height / 2),
  };
}

export interface AskMojiPanelProps {
  /** `floating`: the webapp's fixed panel; `embed`: fills the pages/slides frame. */
  mode: 'floating' | 'embed';
  open: boolean;
  onRequestClose: () => void;
  courseName: string;
  classroomSlug: string;
  pagesUrl: string | null;
  slidesUrl: string | null;
  viewing: AskMojiViewingInput | null;
  /** Told whenever "answering anywhere" changes (the embed posts it to its host). */
  onBusyChange?: (busy: boolean) => void;
  /** A fixed line under the header (the embed's impersonation notice), or none. */
  notice?: string | null;
}

/**
 * The Ask Moji panel, the same in the webapp sidebar and in the pages/slides
 * frame. Always mounted once shown: closing hides it, so a reply keeps
 * streaming. The controller (./controller.ts) holds the conversation.
 */
export default function AskMojiPanel(props: AskMojiPanelProps) {
  const { mode, open, onRequestClose, courseName } = props;
  const controller = useAskMojiController();
  const snapshot = useAskMojiSnapshot();
  const panelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [panelState, setPanelState] = useState<PanelState>(open ? 'open' : 'closed');
  const [expanded, setExpanded] = useState(false);

  // Open/close drive the controller (start, poll) and the genie.
  useEffect(() => {
    if (open) {
      controller.open();
      setPanelState(mode === 'floating' ? 'opening' : 'open');
    } else {
      controller.close();
      setPanelState('closed');
    }
  }, [open, mode, controller]);

  useLayoutEffect(() => {
    if (panelState !== 'opening') return;
    const el = panelRef.current;
    if (!el) return;
    const { x, y } = genieOffset(el);
    el.style.setProperty('--genie-x', `${x}px`);
    el.style.setProperty('--genie-y', `${y}px`);
  }, [panelState]);

  // Focus: the composer on open; the sidebar button on close (floating only;
  // the embed's host hands focus back to its launcher).
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      requestAnimationFrame(() => composerRef.current?.focus());
    } else if (!open && wasOpen.current && mode === 'floating') {
      const active = document.activeElement;
      if (!active || active === document.body || panelRef.current?.contains(active)) {
        (document.querySelector('[data-askmoji-trigger]') as HTMLElement | null)?.focus();
      }
    }
    wasOpen.current = open;
  }, [open, mode]);
  // The embed focuses its composer when the host says open, and once the conversation is up.
  useEffect(() => {
    if (open && snapshot.phase === 'ready') composerRef.current?.focus();
  }, [open, snapshot.phase, snapshot.conversationId]);

  useEscapeWithin(panelRef, onRequestClose);

  return (
    <div
      ref={panelRef}
      className="moji-panel"
      data-mode={mode}
      data-state={panelState}
      {...(expanded ? { 'data-expanded': '' } : {})}
      hidden={panelState === 'closed'}
      role="dialog"
      aria-label="Ask Moji"
      onAnimationEnd={e => {
        if (e.target === e.currentTarget) setPanelState(s => (s === 'opening' ? 'open' : s));
      }}
    >
      {snapshot.chat ? (
        <ChatView
          key={snapshot.chat.id}
          chat={snapshot.chat}
          snapshot={snapshot}
          composerRef={composerRef}
          expanded={expanded}
          onToggleExpanded={() => setExpanded(e => !e)}
          {...props}
        />
      ) : (
        <>
          <Header
            mode={mode}
            courseName={courseName}
            expanded={expanded}
            onToggleExpanded={() => setExpanded(e => !e)}
            onClose={onRequestClose}
            onNew={null}
            newDisabled
          />
          {props.notice && <div className="moji-notice">{props.notice}</div>}
          <div className="moji-body" aria-busy={snapshot.phase === 'starting'}>
            <EmptyState snapshot={snapshot} onRetry={() => controller.retry()} />
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({ snapshot, onRetry }: { snapshot: AskMojiSnapshot; onRetry: () => void }) {
  if (snapshot.phase === 'unavailable') {
    return (
      <div className="moji-state">
        <div className="moji-state-line">{snapshot.line ?? ASK_MOJI_COPY.UNAVAILABLE}</div>
        {snapshot.staffLine && <div className="moji-state-sub">{snapshot.staffLine}</div>}
      </div>
    );
  }
  if (snapshot.phase === 'failed') {
    return (
      <div className="moji-state">
        <div className="moji-error" role="alert">
          {snapshot.line ?? ASK_MOJI_COPY.INIT_FAILED}
        </div>
        <button type="button" className="moji-button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="moji-state" role="status">
      <div className="moji-typing" aria-hidden="true">
        <span className="moji-typing-dot" />
        <span className="moji-typing-dot" />
        <span className="moji-typing-dot" />
      </div>
      <div className="moji-state-sub">{ASK_MOJI_STARTING}</div>
    </div>
  );
}

function Header({
  mode,
  courseName,
  expanded,
  onToggleExpanded,
  onClose,
  onNew,
  newDisabled,
}: {
  mode: 'floating' | 'embed';
  courseName: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
  onNew: (() => void) | null;
  newDisabled: boolean;
}) {
  return (
    <div className="moji-header">
      <div className="moji-dots">
        <span className="moji-status-dot" aria-hidden="true" />
        <div className="moji-dot-actions">
          <button
            type="button"
            className="moji-dot-btn moji-dot-btn--close"
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
          {mode === 'floating' && (
            <button
              type="button"
              className="moji-dot-btn moji-expand"
              onClick={onToggleExpanded}
              aria-label={expanded ? 'Restore size' : 'Expand'}
              title={expanded ? 'Restore size' : 'Expand'}
            >
              {expanded ? (
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3,1 3,3 1,3" />
                  <polyline points="5,7 5,5 7,5" />
                </svg>
              ) : (
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="1,3 1,1 3,1" />
                  <polyline points="7,5 7,7 5,7" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>
      <div className="moji-title">
        <span className="moji-title-name">Ask Moji</span>
        {courseName && <span className="moji-title-course">{courseName}</span>}
      </div>
      <button
        type="button"
        className="moji-new"
        onClick={onNew ?? undefined}
        disabled={newDisabled || !onNew}
        aria-label="New conversation"
        title="New conversation"
      >
        <IconMessagePlus size={15} />
      </button>
    </div>
  );
}

/** How close to the bottom still counts as "at the bottom", in px. */
const AT_BOTTOM_PX = 48;

function ChatView({
  chat,
  snapshot,
  composerRef,
  expanded,
  onToggleExpanded,
  mode,
  onRequestClose,
  courseName,
  classroomSlug,
  pagesUrl,
  slidesUrl,
  viewing,
  onBusyChange,
  notice,
}: AskMojiPanelProps & {
  chat: Chat<AskMojiUIMessage>;
  snapshot: AskMojiSnapshot;
  composerRef: React.RefObject<ComposerHandle | null>;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const controller = useAskMojiController();
  // Externally managed: unmounting this view never stops the chat.
  const { messages, status } = useChat<AskMojiUIMessage>({ chat });

  const streaming = status === 'submitted' || status === 'streaming';
  const answering = streaming || snapshot.serverInFlight;
  const ready = snapshot.phase === 'ready';
  const canSend = ready && !answering && !snapshot.working;

  useEffect(() => {
    onBusyChange?.(answering);
  }, [answering, onBusyChange]);

  // The viewing chip: dismissed for the next message only.
  const wire = useMemo(() => wireViewing(viewing), [viewing]);
  const key = viewingKey(wire);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const included = Boolean(wire) && dismissedKey !== key;
  const label = viewing && wire ? viewingLabel(viewing) : null;

  const onSend = useCallback(
    async (text: string) => {
      const sent = await controller.send(text, included ? wire : null);
      if (sent) setDismissedKey(null);
      return sent;
    },
    [controller, included, wire]
  );

  const onRate = useCallback(
    (id: string, rating: AskMojiRating | null) => void controller.rate(id, rating),
    [controller]
  );
  const chips: ChipContext = useMemo(
    () => ({ classroomSlug, pagesUrl, slidesUrl }),
    [classroomSlug, pagesUrl, slidesUrl]
  );

  // Scroll: follow new content only while at the bottom.
  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  };
  const toBottom = useCallback((smooth: boolean) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);
  useLayoutEffect(() => {
    if (atBottomRef.current) toBottom(false);
  }, [messages, status, snapshot.line, toBottom]);
  // Opening on a long transcript starts at its end.
  useLayoutEffect(() => {
    toBottom(false);
  }, [chat, toBottom]);

  const hasQuestions = messages.some(m => m.role === 'user');
  const last = messages.at(-1);
  const liveId = streaming && last?.role === 'assistant' ? last.id : null;
  const waitingForFirstChunk =
    streaming && (!last || last.role === 'user' || !last.parts.some(p => p.type === 'text'));

  const [announce, setAnnounce] = useState('');
  const wasAnswering = useRef(answering);
  useEffect(() => {
    if (answering && !wasAnswering.current) setAnnounce('Ask Moji is answering');
    else if (!answering && wasAnswering.current) setAnnounce('Answer ready');
    wasAnswering.current = answering;
  }, [answering]);

  // A suggestion is sent like a typed question: the chip's state applies, and
  // a dismissed chip comes back after it went.
  const suggestionClick = (text: string) => void onSend(text);

  let line: ReactNode = null;
  if (snapshot.line && snapshot.line !== ASK_MOJI_COPY.BUSY_ELSEWHERE) {
    line = (
      <div className="moji-error" role="alert">
        {snapshot.line}
      </div>
    );
  }
  const busyLine = snapshot.busyElsewhere || snapshot.line === ASK_MOJI_COPY.BUSY_ELSEWHERE;
  // Thumbs only on stored final answers (the server's `rateable`), and only
  // while nothing streams: never on a live or partial reply.
  const ratingsShown = status === 'ready';

  return (
    <>
      <Header
        mode={mode}
        courseName={courseName}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
        onClose={onRequestClose}
        onNew={() => void controller.newConversation()}
        newDisabled={answering || snapshot.working}
      />
      {notice && <div className="moji-notice">{notice}</div>}
      <div className="moji-body-wrap">
        <div className="moji-body" ref={bodyRef} onScroll={onScroll} aria-busy={answering}>
          {!hasQuestions && (
            <div className="moji-welcome">
              <div className="moji-course-name">{courseName || 'Ask Moji'}</div>
              <div className="moji-course-sub">{snapshot.welcome}</div>
              {snapshot.suggestions.length > 0 && (
                <div className="moji-hints">
                  {snapshot.suggestions.map(s => (
                    <button
                      key={s.text}
                      type="button"
                      className="moji-hint"
                      onClick={() => suggestionClick(s.text)}
                      disabled={!canSend}
                    >
                      <IconChevronRight size={11} aria-hidden="true" />
                      <span>{s.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages.map(message => (
            <AskMojiMessageView
              key={message.id}
              message={message}
              live={message.id === liveId}
              rateable={ratingsShown && message.metadata?.rateable === true}
              rating={snapshot.ratings[message.id] ?? null}
              onRate={onRate}
              chips={chips}
            />
          ))}
          {waitingForFirstChunk && (
            <div className="moji-typing moji-typing--inline" aria-hidden="true">
              <span className="moji-typing-dot" />
              <span className="moji-typing-dot" />
              <span className="moji-typing-dot" />
            </div>
          )}
          {line}
        </div>
        {!atBottom && (
          <button
            type="button"
            className="moji-jump"
            onClick={() => toBottom(true)}
            aria-label="Jump to latest"
            title="Jump to latest"
          >
            <IconArrowDown size={14} />
          </button>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {busyLine ? (
        <div className="moji-busy-line">{ASK_MOJI_COPY.BUSY_ELSEWHERE}</div>
      ) : (
        snapshot.hint && (
          <div className="moji-busy-line" role="status">
            {snapshot.hint}
          </div>
        )
      )}
      {snapshot.phase === 'ended' && (
        <div className="moji-ended">
          <button
            type="button"
            className="moji-button"
            onClick={() => void controller.newConversation()}
            disabled={snapshot.working}
          >
            New conversation
          </button>
        </div>
      )}
      <Composer
        ref={composerRef}
        conversationId={snapshot.conversationId}
        canSend={canSend}
        disabled={!ready}
        onSend={onSend}
        onEdit={() => {
          controller.clearLine();
          // The first keystroke starts the session (never open or focus).
          controller.preload();
        }}
        onBlocked={() => controller.blocked()}
        viewingLabel={label}
        viewingIncluded={included}
        onDismissViewing={() => setDismissedKey(key)}
        restore={snapshot.restore}
      />
    </>
  );
}
