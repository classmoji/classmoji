import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { IconArrowUp, IconEye, IconX } from '@tabler/icons-react';
import { MAX_MESSAGE_CHARS } from '@classmoji/utils/ask-moji';

/** The counter shows once a question is this close to the limit. */
export const COUNTER_FROM = MAX_MESSAGE_CHARS - 500;

/** Screen readers hear the length only when it crosses into one of these bands. */
export const COUNTER_ANNOUNCE_FROM = Math.floor(MAX_MESSAGE_CHARS * 0.9);

export type CounterBand = 'none' | 'near' | 'limit' | 'over';

/** Which announcement band a length is in (`none` below 90% of the limit). */
export const counterBand = (length: number): CounterBand =>
  length > MAX_MESSAGE_CHARS
    ? 'over'
    : length === MAX_MESSAGE_CHARS
      ? 'limit'
      : length >= COUNTER_ANNOUNCE_FROM
        ? 'near'
        : 'none';

const MAX_LABEL = MAX_MESSAGE_CHARS.toLocaleString('en-US');

/** What a band announces, once, on entering it. */
export const counterAnnouncement = (band: CounterBand, length: number): string => {
  switch (band) {
    case 'near':
      return `${length.toLocaleString('en-US')} of ${MAX_LABEL} characters`;
    case 'limit':
      return `${MAX_LABEL} character limit reached`;
    case 'over':
      return `Over the ${MAX_LABEL} character limit`;
    default:
      return '';
  }
};

const draftKey = (conversationId: string) => `classmoji:ask-moji:draft:${conversationId}`;

export const readDraft = (conversationId: string | null): string => {
  if (!conversationId || typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(draftKey(conversationId)) ?? '';
  } catch {
    return '';
  }
};

export const writeDraft = (conversationId: string | null, text: string) => {
  if (!conversationId || typeof window === 'undefined') return;
  try {
    if (text) window.sessionStorage.setItem(draftKey(conversationId), text);
    else window.sessionStorage.removeItem(draftKey(conversationId));
  } catch {
    // Storage unavailable: the draft lives only in the composer.
  }
};

/** Enter sends; Shift+Enter (and Enter while an IME is composing) adds a line. */
export const isSendKey = (e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'nativeEvent'>) =>
  e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as { isComposing?: boolean }).isComposing;

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
}

interface ComposerProps {
  conversationId: string | null;
  /** Sending is possible right now (nothing in flight, the conversation open). */
  canSend: boolean;
  /** The composer takes no input at all (no conversation yet). */
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
  /** The user typed (a shown line has been read; the first keystroke starts the session). */
  onEdit?: () => void;
  /** Enter or Send with a question while nothing can be sent: the panel says why. */
  onBlocked?: () => void;
  /** The "Viewing" chip: its label, or null for none. */
  viewingLabel: string | null;
  viewingIncluded: boolean;
  onDismissViewing: () => void;
  /** A question to put back (its turn got no answer); applied when the composer is empty. */
  restore: { text: string; nonce: number } | null;
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    conversationId,
    canSend,
    disabled,
    onSend,
    onEdit,
    onBlocked,
    viewingLabel,
    viewingIncluded,
    onDismissViewing,
    restore,
  },
  ref
) {
  const [text, setTextState] = useState(() => readDraft(conversationId));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      writeDraft(conversationId, next);
    },
    [conversationId]
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      setText,
    }),
    [setText]
  );

  // Each conversation has its own draft.
  useEffect(() => {
    setTextState(readDraft(conversationId));
  }, [conversationId]);

  // A question whose turn got no answer comes back, unless something is typed.
  const restoredNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!restore || restoredNonce.current === restore.nonce) return;
    restoredNonce.current = restore.nonce;
    if (!textRef.current.trim()) setText(restore.text);
  }, [restore, setText]);

  // Grow with the text, up to the CSS max-height.
  // Not while hidden (a closed panel measures 0): a question restored then
  // would leave the composer a sliver tall. Measured again on focus.
  const autosize = useCallback(() => {
    const el = textareaRef.current;
    if (!el || el.offsetParent === null) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(() => {
    autosize();
  }, [text, autosize]);

  const length = text.length;
  const over = length > MAX_MESSAGE_CHARS;
  const hasQuestion = text.trim().length > 0 && !over;
  const sendable = canSend && !disabled && hasQuestion;

  // The length is announced on entering a band (90%, the limit, over), not
  // on every keystroke.
  const band = counterBand(length);
  const [announced, setAnnounced] = useState('');
  const lastBand = useRef<CounterBand>(band);
  useEffect(() => {
    if (band === lastBand.current) return;
    lastBand.current = band;
    setAnnounced(counterAnnouncement(band, length));
  }, [band, length]);

  const submit = useCallback(async () => {
    if (!sendable) {
      // A question that can't go right now: say why rather than nothing.
      if (hasQuestion && !disabled) onBlocked?.();
      return;
    }
    const sent = await onSend(textRef.current);
    if (sent) setText('');
  }, [sendable, hasQuestion, disabled, onBlocked, onSend, setText]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSendKey(e)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="moji-composer">
      {viewingLabel && viewingIncluded && (
        <div className="moji-viewing">
          <IconEye size={12} aria-hidden="true" />
          <span className="moji-viewing-text">Viewing: {viewingLabel}</span>
          <button
            type="button"
            className="moji-viewing-dismiss"
            onClick={onDismissViewing}
            aria-label="Leave this out of the next question"
            title="Leave this out of the next question"
          >
            <IconX size={11} />
          </button>
        </div>
      )}
      <div className="moji-input-row">
        <textarea
          ref={textareaRef}
          className="moji-input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Ask about the course…"
          aria-label="Ask Moji a question"
          onChange={e => {
            setText(e.target.value);
            onEdit?.();
          }}
          onKeyDown={onKeyDown}
          onFocus={autosize}
        />
        <button
          type="button"
          className="moji-send"
          onClick={() => void submit()}
          disabled={!sendable}
          aria-label="Send"
          title="Send"
        >
          <IconArrowUp size={15} />
        </button>
      </div>
      {length >= COUNTER_FROM && (
        <div className={`moji-counter${over ? ' moji-counter--over' : ''}`} aria-hidden="true">
          {length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
        </div>
      )}
      <div className="sr-only" aria-live="polite" data-testid="moji-counter-announce">
        {announced}
      </div>
    </div>
  );
});

export default Composer;
