import { useEffect, useId, useRef, useState } from 'react';

/** The longest note a version may carry (it becomes part of the commit message). */
export const VERSION_NOTE_MAX = 200;

/**
 * "Save version" with an optional note: the button opens a small popover
 * with one text field; Enter (or Save) asks for the version, Escape closes.
 */
export default function SaveVersionPopover({
  onSave,
  saving,
  disabled = false,
}: {
  onSave: (message: string) => void;
  saving: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    onSave(note.trim());
    setNote('');
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        disabled={disabled || saving}
        aria-expanded={open}
        aria-controls={panelId}
        className="px-2.5 py-1 text-sm font-medium rounded-md transition-colors text-gray-700 ring-1 ring-gray-300 hover:bg-gray-100 disabled:opacity-60 disabled:cursor-not-allowed dark:text-gray-200 dark:ring-gray-600 dark:hover:bg-gray-700"
      >
        {saving ? 'Saving version…' : 'Save version'}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className="absolute right-0 top-full z-[1150] mt-2 w-72 rounded-lg bg-white p-3 shadow-lg ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700"
        >
          <form onSubmit={submit}>
            <label
              htmlFor={`${panelId}-note`}
              className="block text-xs font-medium text-gray-600 dark:text-gray-300"
            >
              Note (optional)
            </label>
            <input
              ref={inputRef}
              id={`${panelId}-note`}
              type="text"
              value={note}
              maxLength={VERSION_NOTE_MAX}
              onChange={event => setNote(event.target.value)}
              placeholder="What changed?"
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="submit"
                className="px-3 py-1 text-sm font-medium rounded-md bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
