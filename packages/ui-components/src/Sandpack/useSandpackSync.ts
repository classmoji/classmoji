/**
 * useSandpackSync - Hook to sync Sandpack code changes to DOM
 *
 * This hook provides a callback that updates the JSON script tag
 * inside a .sandpack-embed element when files change.
 */

import { useCallback, useRef } from 'react';
import { syncEditedFiles } from './utils.ts';

/**
 * Hook to create a file sync callback for a Sandpack embed element
 *
 * @param element - The .sandpack-embed container element
 * @param onContentChange - Callback to notify of content changes
 * @returns Callback to sync files to the element
 */
export default function useSandpackSync(
  element: HTMLElement | null,
  onContentChange?: () => void
): (files: Record<string, string>, baseline?: Record<string, string>) => void {
  const elementRef = useRef(element);
  elementRef.current = element;

  const syncFiles = useCallback(
    (files: Record<string, string>, baseline?: Record<string, string>) => {
      const el = elementRef.current;
      if (!el) return;

      if (syncEditedFiles(el, files, baseline)) onContentChange?.();
    },
    [onContentChange]
  );

  return syncFiles;
}
