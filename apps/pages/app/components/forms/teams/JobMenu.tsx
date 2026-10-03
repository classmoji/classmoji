import { IconCheck, IconChevronDown } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { useViewportClamp } from './useViewportClamp.ts';

/**
 * A question row's Job control: a button that shows the chosen job and opens
 * the list of jobs the question can take, each with its name and a one-line
 * fact; the chosen one has a check.
 *
 * A button with a listbox (`aria-haspopup="listbox"`). Opening moves focus to
 * the list, on the chosen job; Up / Down / Home / End move, Enter or Space
 * choose, Escape or Tab close, and focus goes back to the button. Up, Down,
 * Enter or Space on the button opens it too. A click elsewhere closes it. The button's name
 * is `label` ("Job: <question>") followed by the chosen job's name. The list
 * is kept inside the viewport (`useViewportClamp`).
 *
 * Presentational: props in, the chosen value out (only when it changes).
 */

export interface JobMenuChoice {
  /** '' = no job. */
  value: string;
  name: string;
  fact: string;
}

export interface JobMenuProps {
  /** The button's id. */
  id: string;
  /** The start of the button's accessible name: "Job: <question>". */
  label: string;
  choices: readonly JobMenuChoice[];
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}

export function JobMenu({ id, label, choices, value, disabled, onChange }: JobMenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useViewportClamp(listRef, open);

  const selected = Math.max(
    0,
    choices.findIndex(choice => choice.value === value)
  );
  const current = choices[selected];

  const show = () => {
    setActive(selected);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const choose = (index: number) => {
    const next = choices[index];
    close();
    if (next && next.value !== value) onChange(next.value);
  };

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // `optionId` is derived from `baseId`, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Enter and Space act on keydown, not through the button's click: Firefox
  // and Safari click a button on Space's keyup, which would land on the
  // button after Space chose a job in the list and open it again.
  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        show();
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) close();
        else show();
        break;
    }
  };

  const onButtonKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ') event.preventDefault();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = choices.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(index => Math.min(last, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(index => Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'Tab':
        // Back on the button, Tab goes on from there.
        close();
        break;
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${labelId} ${valueId}`}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onButtonKeyDown}
        onKeyUp={onButtonKeyUp}
        className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-gray-300 bg-white py-1 pl-2 pr-1.5 text-xs text-gray-900 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-white dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:hover:bg-gray-800 dark:disabled:hover:bg-gray-900"
      >
        <span id={valueId} className="truncate">
          {current?.name}
        </span>
        <IconChevronDown
          size={14}
          aria-hidden="true"
          className="shrink-0 text-gray-500 dark:text-gray-400"
        />
      </button>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        tabIndex={-1}
        aria-labelledby={labelId}
        aria-activedescendant={open ? optionId(active) : undefined}
        hidden={!open}
        onKeyDown={onListKeyDown}
        className="absolute right-0 top-full z-30 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-gray-200 bg-white p-1 shadow-lg focus:outline-none dark:border-gray-700 dark:bg-gray-900"
      >
        {choices.map((choice, index) => {
          const chosen = index === selected;
          return (
            <li
              key={choice.value}
              id={optionId(index)}
              role="option"
              aria-selected={chosen}
              aria-labelledby={`${optionId(index)}-name`}
              aria-describedby={`${optionId(index)}-fact`}
              data-value={choice.value}
              data-active={index === active ? 'true' : undefined}
              onClick={() => choose(index)}
              onPointerMove={() => {
                if (index !== active) setActive(index);
              }}
              className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 data-[active=true]:bg-gray-100 dark:data-[active=true]:bg-gray-800"
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {chosen ? (
                  <IconCheck
                    size={14}
                    aria-hidden="true"
                    className="text-gray-900 dark:text-white"
                  />
                ) : null}
              </span>
              <span className="min-w-0">
                <span
                  id={`${optionId(index)}-name`}
                  className={`block text-sm text-gray-900 dark:text-white ${
                    chosen ? 'font-semibold' : 'font-medium'
                  }`}
                >
                  {choice.name}
                </span>
                <span
                  id={`${optionId(index)}-fact`}
                  className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400"
                >
                  {choice.fact}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default JobMenu;
