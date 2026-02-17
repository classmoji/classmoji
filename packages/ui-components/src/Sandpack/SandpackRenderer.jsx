/**
 * SandpackRenderer - Mounts Sandpack components into innerHTML contexts
 *
 * Uses MutationObserver to detect .sandpack-embed elements in the DOM and
 * mounts React Sandpack components into them. This is necessary for contexts
 * like Reveal.js slides where content is set via innerHTML rather than React rendering.
 *
 * Usage:
 *   <SandpackRenderer
 *     containerSelector=".reveal .slides"
 *     slideTheme="white"
 *     onContentChange={() => console.log('Content changed')}
 *   />
 */

import { useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import SandpackEmbed from './SandpackEmbed.jsx';
import { parseFromHtml, updateFilesInElement } from './utils.js';

/**
 * SandpackRenderer component
 *
 * @param {object} props
 * @param {string} [props.containerSelector='.reveal .slides'] - CSS selector for the container to watch
 * @param {string} [props.slideTheme] - Current slide theme for auto theme detection
 * @param {function} [props.onContentChange] - Callback when Sandpack content changes
 * @param {boolean} [props.isEditing=false] - Whether in edit mode (enables file sync)
 */
export default function SandpackRenderer({
  containerSelector = '.reveal .slides',
  slideTheme,
  onContentChange,
  isEditing = false,
}) {
  // Track mounted React roots so we can clean them up
  const rootsRef = useRef(new Map());
  // Track observed elements to avoid double-mounting
  const observedRef = useRef(new WeakSet());

  /**
   * Mount a Sandpack component into an embed element
   */
  const mountSandpack = useCallback(
    embedEl => {
      // Skip if already mounted
      if (observedRef.current.has(embedEl)) return;
      observedRef.current.add(embedEl);

      // Parse configuration from HTML
      const config = parseFromHtml(embedEl);

      // Create a mount point inside the embed element
      let mountPoint = embedEl.querySelector('.sandpack-mount');
      if (!mountPoint) {
        mountPoint = document.createElement('div');
        mountPoint.className = 'sandpack-mount';
        embedEl.appendChild(mountPoint);
      }

      // Handle file changes - sync back to the JSON script tag
      const handleFilesChange = isEditing
        ? files => {
            updateFilesInElement(embedEl, files);
            onContentChange?.();
          }
        : undefined;

      // Create React root and render Sandpack
      const root = createRoot(mountPoint);
      root.render(
        <SandpackEmbed
          template={config.template}
          theme={config.theme}
          layout={config.layout}
          files={config.files}
          options={config.options}
          onFilesChange={handleFilesChange}
          slideTheme={slideTheme}
          editorWidthPercentage={config.editorWidthPercentage}
        />
      );

      // Store root for cleanup
      rootsRef.current.set(embedEl, root);
    },
    [slideTheme, onContentChange, isEditing]
  );

  /**
   * Unmount a Sandpack component from an embed element
   */
  const unmountSandpack = useCallback(embedEl => {
    const root = rootsRef.current.get(embedEl);
    if (root) {
      root.unmount();
      rootsRef.current.delete(embedEl);
    }
    observedRef.current.delete(embedEl);

    // Clean up mount point
    const mountPoint = embedEl.querySelector('.sandpack-mount');
    if (mountPoint) {
      mountPoint.remove();
    }
  }, []);

  /**
   * Re-render a Sandpack component with updated configuration
   * Called when data attributes change on the embed element
   */
  const rerenderSandpack = useCallback(
    embedEl => {
      const root = rootsRef.current.get(embedEl);
      if (!root) return;

      // Parse fresh configuration from the element
      const config = parseFromHtml(embedEl);

      // Handle file changes - sync back to the JSON script tag
      const handleFilesChange = isEditing
        ? files => {
            updateFilesInElement(embedEl, files);
            onContentChange?.();
          }
        : undefined;

      // Re-render with new config
      root.render(
        <SandpackEmbed
          template={config.template}
          theme={config.theme}
          layout={config.layout}
          files={config.files}
          options={config.options}
          onFilesChange={handleFilesChange}
          slideTheme={slideTheme}
          editorWidthPercentage={config.editorWidthPercentage}
        />
      );
    },
    [slideTheme, onContentChange, isEditing]
  );

  /**
   * Scan for and mount all Sandpack embeds in the container
   */
  const scanAndMount = useCallback(
    container => {
      const embeds = container.querySelectorAll('.sandpack-embed');
      embeds.forEach(embed => {
        if (!rootsRef.current.has(embed)) {
          mountSandpack(embed);
        }
      });
    },
    [mountSandpack]
  );

  useEffect(() => {
    let observer = null;
    let retryTimeout = null;
    let retryCount = 0;
    const maxRetries = 20; // Try for up to 2 seconds (20 * 100ms)

    const setupObserver = () => {
      // Find the container element
      const container = document.querySelector(containerSelector);
      if (!container) {
        retryCount++;
        if (retryCount < maxRetries) {
          // Container not ready yet, retry after a short delay
          retryTimeout = setTimeout(setupObserver, 100);
        } else {
          console.warn(`SandpackRenderer: Container not found for selector "${containerSelector}" after ${maxRetries} retries`);
        }
        return;
      }

      // Initial scan - mount existing embeds
      scanAndMount(container);

      // Set up MutationObserver to watch for new embeds and attribute changes
      observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          // Check added nodes for sandpack embeds
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const el = /** @type {Element} */ (node);
                // Check if the node itself is a sandpack embed
                if (el.classList?.contains('sandpack-embed')) {
                  mountSandpack(el);
                }
                // Check for sandpack embeds inside the added node
                const embeds = el.querySelectorAll?.('.sandpack-embed');
                embeds?.forEach(embed => mountSandpack(embed));
              }
            });

            // Check removed nodes for cleanup
            mutation.removedNodes.forEach(node => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const el = /** @type {Element} */ (node);
                if (el.classList?.contains('sandpack-embed')) {
                  unmountSandpack(el);
                }
                const embeds = el.querySelectorAll?.('.sandpack-embed');
                embeds?.forEach(embed => unmountSandpack(embed));
              }
            });
          }

          // Check for attribute changes on sandpack embeds
          if (mutation.type === 'attributes') {
            const el = /** @type {Element} */ (mutation.target);
            if (el.classList?.contains('sandpack-embed')) {
              rerenderSandpack(el);
            }
          }
        }
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'data-template',
          'data-theme',
          'data-layout',
          'data-show-tabs',
          'data-show-line-numbers',
          'data-show-console',
          'data-read-only',
          'data-visible-files',
          'data-editor-width',
        ],
      });
    };

    // Start trying to set up the observer
    setupObserver();

    // Cleanup function - copy refs to local variables to avoid stale closures
    const currentRoots = rootsRef.current;
    return () => {
      if (retryTimeout) clearTimeout(retryTimeout);
      if (observer) observer.disconnect();
      // Unmount all React roots
      currentRoots.forEach(root => {
        root.unmount();
      });
      currentRoots.clear();
      observedRef.current = new WeakSet();
    };
  }, [containerSelector, scanAndMount, mountSandpack, unmountSandpack, rerenderSandpack]);

  // Re-mount when slideTheme changes (for auto theme)
  useEffect(() => {
    rootsRef.current.forEach((root, embedEl) => {
      const config = parseFromHtml(embedEl);

      // Only re-render if theme is 'auto'
      if (config.theme === 'auto') {
        const handleFilesChange = isEditing
          ? files => {
              updateFilesInElement(embedEl, files);
              onContentChange?.();
            }
          : undefined;

        root.render(
          <SandpackEmbed
            template={config.template}
            theme={config.theme}
            layout={config.layout}
            files={config.files}
            options={config.options}
            onFilesChange={handleFilesChange}
            slideTheme={slideTheme}
            editorWidthPercentage={config.editorWidthPercentage}
          />
        );
      }
    });
  }, [slideTheme, isEditing, onContentChange]);

  // This component doesn't render anything itself
  return null;
}
