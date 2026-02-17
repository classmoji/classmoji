import { useState, useCallback, useEffect, useRef } from 'react';
import { useRevalidator } from 'react-router';

/**
 * Hook for managing GitHub App installation via popup window.
 * Opens installation in a popup, detects when it closes, and refreshes loader data.
 *
 * @param {string} githubAppName - The GitHub App name (e.g., "classmoji")
 * @returns {{ openInstallPopup: () => void, isRefreshing: boolean }}
 */
export const useGitHubAppInstallPopup = githubAppName => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const revalidator = useRevalidator();
  const popupRef = useRef(null);
  const pollIntervalRef = useRef(null);

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
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
        popupRef.current = null;
        setIsRefreshing(true);

        // Wait for webhook to process before revalidating
        // GitHub sends webhook async, Trigger.dev processes it (~500ms typical)
        setTimeout(() => {
          revalidator.revalidate();
        }, 1500);
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
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  return {
    openInstallPopup,
    isRefreshing,
  };
};
