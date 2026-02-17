/**
 * useSandpackSync - Hook to sync Sandpack code changes to DOM
 *
 * This hook provides a callback that updates the JSON script tag
 * inside a .sandpack-embed element when files change.
 */

import { useCallback, useRef } from 'react';
import { updateFilesInElement } from './utils.js';

/**
 * Hook to create a file sync callback for a Sandpack embed element
 *
 * @param {HTMLElement | null} element - The .sandpack-embed container element
 * @param {function} [onContentChange] - Callback to notify of content changes
 * @returns {function} Callback to sync files to the element
 */
export default function useSandpackSync(element, onContentChange) {
  const elementRef = useRef(element);
  elementRef.current = element;

  const syncFiles = useCallback(
    files => {
      const el = elementRef.current;
      if (!el) return;

      updateFilesInElement(el, files);
      onContentChange?.();
    },
    [onContentChange]
  );

  return syncFiles;
}
