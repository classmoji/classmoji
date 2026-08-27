import { useCallback, useEffect, useRef } from 'react';
import { useNavigation, useSubmit } from 'react-router';

/**
 * Search-as-you-type for a plain `<Form method="get">`.
 *
 * The form stays a real GET form, so the query lives in the URL (shareable,
 * survives reload) and still works with JS off — this only replaces the need to
 * press a button.
 *
 * @param currentQuery the query the loader actually ran, used to know when a
 *   re-render may have stolen focus from the input.
 */
export function useDebouncedSearch(currentQuery: string, delayMs = 250) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onSearchChange = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      const form = event.currentTarget;
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        // `replace` keeps every keystroke out of history, so Back leaves the
        // page instead of walking the query backwards one character at a time.
        submit(form, { replace: true });
      }, delayMs);
    },
    [submit, delayMs]
  );

  // A pending debounce outliving the component would submit a detached form.
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // The loader re-render can drop the caret; put it back at the end, but only
  // while the user is actually in the field.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) return;
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [currentQuery]);

  return { inputRef, onSearchChange, searching: navigation.state !== 'idle' };
}
