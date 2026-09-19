import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * "Copy link", with the brief inline confirmation the forms list already uses.
 *
 * Shared rather than duplicated because the builder and the list copy the SAME
 * URL and must agree about it — including the flash of feedback, which is the
 * only thing that tells anyone the click did something.
 *
 * `copiedKey` rather than a boolean: the list copies one of many rows and has to
 * put the confirmation on the row that was clicked. A single-button caller can
 * ignore the key and compare against its own.
 */
export function useCopyLink(resetMs = 1500): {
  copiedKey: string | null;
  copy: (text: string, key?: string) => Promise<void>;
} {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The timeout outlives the component otherwise, and fires setState on an
  // unmounted tree — which the builder can reach by navigating to Responses
  // within the flash window.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string, key = 'link') => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard is permission-gated and blocked outright in some embedded
        // contexts. The link is visible on the row's View action either way, so
        // a refusal is a non-event rather than an error to shout about.
        return;
      }
      setCopiedKey(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(
        () => setCopiedKey(current => (current === key ? null : current)),
        resetMs
      );
    },
    [resetMs]
  );

  return { copiedKey, copy };
}
