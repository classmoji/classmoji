import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { IconArrowUp } from '@tabler/icons-react';

import { COMMENT_BODY_MAX } from './types.ts';

/**
 * A comment box: Enter sends, Shift+Enter starts a new line, at most
 * `COMMENT_BODY_MAX` characters. Grows with its text up to a few lines.
 * Cleared after a send the server took; kept (with the text) otherwise.
 */
interface ComposerProps {
  placeholder: string;
  /** Accessible name of the box. */
  label: string;
  submitLabel?: string;
  initialValue?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  /** Shown as a text button beside Send (edit mode). */
  cancelLabel?: string;
}

const MAX_HEIGHT = 180;

export function Composer({
  placeholder,
  label,
  submitLabel = 'Send',
  initialValue = '',
  autoFocus = false,
  onSubmit,
  onCancel,
  cancelLabel,
}: ComposerProps) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const counterId = useId();

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!autoFocus) return;
    const element = ref.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocus]);

  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && value.length <= COMMENT_BODY_MAX && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    const ok = await onSubmit(value.replace(/\r\n?/g, '\n').trim());
    setBusy(false);
    if (ok && !initialValue) setValue('');
  };

  const nearLimit = value.length > COMMENT_BODY_MAX - 400;

  return (
    <div className="rounded-lg bg-white ring-1 ring-stone-200 focus-within:ring-2 focus-within:ring-blue-500 dark:bg-neutral-950 dark:ring-neutral-700 dark:focus-within:ring-blue-400">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        maxLength={COMMENT_BODY_MAX}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={nearLimit ? counterId : undefined}
        disabled={busy}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          } else if (event.key === 'Escape' && onCancel) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        className="block w-full resize-none bg-transparent px-3 pt-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none disabled:opacity-60 dark:text-gray-100 dark:placeholder:text-gray-500"
      />
      <div className="flex items-center justify-end gap-2 px-2 pb-1.5">
        {nearLimit && (
          <span
            id={counterId}
            className={`mr-auto pl-1 text-xs ${value.length >= COMMENT_BODY_MAX ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
          >
            {value.length}/{COMMENT_BODY_MAX}
          </span>
        )}
        {onCancel && cancelLabel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-800"
          >
            {cancelLabel}
          </button>
        )}
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          aria-label={submitLabel}
          title={`${submitLabel} (Enter)`}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 text-white transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-30 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
        >
          <IconArrowUp size={15} stroke={2.25} />
        </button>
      </div>
    </div>
  );
}
