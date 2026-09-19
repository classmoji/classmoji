import { useState, useCallback, useEffect, useRef } from 'react';
import { useRevalidator } from 'react-router';

/**
 * Hook for managing GitHub App installation via popup window.
 * Opens installation in a popup, detects when it closes, and refreshes loader data.
 *
 * @param {string} githubAppName - The GitHub App name (e.g., "classmoji")
 * @param {() => void} [onClosed] - Called INSTEAD of the plain revalidate when
 *   the popup closes. Callers that need more than a loader refresh supply this:
 *   the install banner posts to the "check again" endpoint, whose action
 *   reconciles the installation id and revalidates the page's loaders itself.
 *   Left out, the popup revalidates exactly as before — create-classroom relies
 *   on that, because its loader syncs installations live from GitHub.
 * @returns {{ openInstallPopup: () => void, isRefreshing: boolean }}
 */
export const useGitHubAppInstallPopup = (
  githubAppName: string | undefined,
  onClosed?: () => void
) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const revalidator = useRevalidator();
  const popupRef = useRef<Window | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Held in a ref so callers may pass an inline arrow without re-creating
  // `openInstallPopup`, and so the poll always invokes the CURRENT callback
  // rather than the one captured when the popup was opened.
  //
  // Written in an effect rather than during render: a render-phase ref write is
  // a side effect React is free to throw away (a discarded concurrent render,
  // StrictMode's double invoke), and the popup poll reads this ref long after
  // the render that set it.
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  const openInstallPopup = useCallback(() => {
    // Don't open multiple popups
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus();
      return;
    }
    const url = `https://github.com/apps/${githubAppName}/installations/new`;
    const width = 1024;
    const height = 768;
    const left = (window.innerWidth - width) / 2 + window.screenX;
    const top = (window.innerHeight - height) / 2 + window.screenY;

    popupRef.current = window.open(
      url,
      'github-app-install',
      `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
    );

    // Handle popup blocked by browser
    if (!popupRef.current) {
      window.open(url, '_blank');
      return;
    }

    // Poll for popup close
    pollIntervalRef.current = setInterval(() => {
      if (popupRef.current?.closed) {
        clearInterval(pollIntervalRef.current!);
        pollIntervalRef.current = null;
        popupRef.current = null;

        // A supplied callback OWNS the refresh: revalidating as well would race
        // its request against a loader read of the same row and report "still
        // not installed" from the stale answer that happened to land last.
        if (onClosedRef.current) {
          onClosedRef.current();
          return;
        }

        setIsRefreshing(true);

        // Revalidate immediately. The create-classroom loader syncs the user's
        // installations live from GitHub (and upserts the GitOrganization rows),
        // so the just-installed org is available without waiting on the async
        // installation.created webhook.
        revalidator.revalidate();
      }
    }, 500);
  }, [githubAppName, revalidator]);

  // Update isRefreshing when revalidation completes
  useEffect(() => {
    if (revalidator.state === 'idle' && isRefreshing) {
      setIsRefreshing(false);
    }
  }, [revalidator.state, isRefreshing]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  return {
    openInstallPopup,
    isRefreshing,
  };
};
