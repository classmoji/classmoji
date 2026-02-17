import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import {
  handleCodeBlockTab,
  handleCodeBlockEnter,
} from './properties/utils/codeBlockUtils';

// Built-in Reveal.js themes (exported for use in SlideToolbar)
export const BUILTIN_THEMES = ['black', 'white', 'league', 'beige', 'night', 'serif', 'simple', 'solarized', 'moon', 'dracula', 'sky', 'blood'];

// Theme categories for better UX in dropdowns
export const LIGHT_THEMES = ['white', 'beige', 'sky', 'serif', 'simple', 'solarized'];
export const DARK_THEMES = ['black', 'league', 'night', 'moon', 'dracula', 'blood'];

/**
 * Get the URL for a theme stylesheet
 * @param {string} theme - Theme name or custom/shared theme ID
 * @param {Array<{id: string, cssUrl: string}>} customThemes - Custom themes with their URLs
 * @param {Array<{id: string, libCssUrl: string}>} sharedThemes - Shared themes from slides.com imports
 * @returns {string} Full URL to the theme CSS
 */
function getThemeUrl(theme, customThemes = [], sharedThemes = []) {
  if (BUILTIN_THEMES.includes(theme)) {
    return `https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/${theme}.css`;
  }
  // Check if this is a custom theme ID (format: "custom:filename.css")
  if (theme.startsWith('custom:')) {
    const customTheme = customThemes.find(t => t.id === theme);
    if (customTheme?.cssUrl) {
      return customTheme.cssUrl;
    }
  }
  // Check if this is a shared theme ID (format: "shared:theme-name")
  if (theme.startsWith('shared:')) {
    const sharedTheme = sharedThemes.find(t => t.id === theme);
    if (sharedTheme?.libCssUrl) {
      return sharedTheme.libCssUrl;
    }
  }
  // Fallback: treat as relative path or return as-is
  return theme;
}

/**
 * RevealSlides - Renders a Reveal.js presentation
 *
 * Fetches HTML content from GitHub Pages and initializes Reveal.js
 * Supports both view and edit modes with save functionality
 * Dynamically loads themes based on system color scheme preference
 *
 * Note: Reveal.js is dynamically imported to avoid SSR issues
 */
const RevealSlides = forwardRef(function RevealSlides({
  contentUrl,
  initialContent = null,  // Pre-fetched content from server (bypasses CORS)
  initialError = null,    // Error from server-side fetch
  canEdit = false,
  isEditing = false,
  onContentChange,
  onThemeChange,          // Callback when themes are extracted from content
  customThemes = [],      // Custom themes with cssUrl for loading
  sharedThemes = [],      // Shared themes from slides.com imports (with lib/ folder)
}, ref) {
  const deckRef = useRef(null);
  const revealRef = useRef(null);
  const [loading, setLoading] = useState(!initialContent && !initialError);
  const [error, setError] = useState(initialError);
  const [htmlContent, setHtmlContent] = useState(null);
  const [isClient, setIsClient] = useState(false);

  // Theme state - single theme (no light/dark mode split for simplicity)
  const [theme, setTheme] = useState('white');
  const [codeTheme, setCodeTheme] = useState('github');
  const themeStyleRef = useRef(null);
  const codeThemeStyleRef = useRef(null);
  // Track custom theme CSS link (for shared themes with custom-theme.css)
  const customThemeStyleRef = useRef(null);
  // Track body classes added by shared themes
  const sharedThemeBodyClassesRef = useRef([]);

  // Hydration check - only render on client
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Theme loading
  useEffect(() => {
    if (!isClient) return;

    const themeUrl = getThemeUrl(theme, customThemes, sharedThemes);

    // Remove existing theme stylesheet if present
    if (themeStyleRef.current) {
      themeStyleRef.current.remove();
    }

    // Remove existing custom theme stylesheet if present
    if (customThemeStyleRef.current) {
      customThemeStyleRef.current.remove();
      customThemeStyleRef.current = null;
    }

    // Remove previously added body classes from shared themes
    if (sharedThemeBodyClassesRef.current.length > 0) {
      document.body.classList.remove(...sharedThemeBodyClassesRef.current);
      sharedThemeBodyClassesRef.current = [];
    }

    // Create new link element for theme
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = themeUrl;
    link.id = 'reveal-theme-dynamic';

    // Recalculate Reveal.js layout after theme CSS loads
    link.onload = () => {
      if (revealRef.current) {
        revealRef.current.layout();
      }
    };
    link.onerror = () => {
      console.error('[Theme] Failed to load CSS:', themeUrl);
    };

    document.head.appendChild(link);
    themeStyleRef.current = link;

    // If this is a shared theme, also apply body classes and custom theme CSS
    if (theme.startsWith('shared:')) {
      const sharedTheme = sharedThemes.find(t => t.id === theme);
      if (sharedTheme) {
        // Apply body classes (e.g., "reveal-viewport theme-font-montserrat theme-color-white-blue")
        if (sharedTheme.bodyClasses) {
          const classes = sharedTheme.bodyClasses.split(' ').filter(/** @param {string} c */ c => c.trim());
          document.body.classList.add(...classes);
          sharedThemeBodyClassesRef.current = classes;
        }

        // Load custom theme CSS if present
        if (sharedTheme.customThemeUrl) {
          const customLink = document.createElement('link');
          customLink.rel = 'stylesheet';
          customLink.href = sharedTheme.customThemeUrl;
          customLink.id = 'reveal-custom-theme';
          document.head.appendChild(customLink);
          customThemeStyleRef.current = customLink;
        }
      }
    }

    return () => {
      // Clean up theme stylesheet on unmount
      if (themeStyleRef.current) {
        themeStyleRef.current.remove();
        themeStyleRef.current = null;
      }
      if (customThemeStyleRef.current) {
        customThemeStyleRef.current.remove();
        customThemeStyleRef.current = null;
      }
      // Clean up body classes
      if (sharedThemeBodyClassesRef.current.length > 0) {
        document.body.classList.remove(...sharedThemeBodyClassesRef.current);
        sharedThemeBodyClassesRef.current = [];
      }
    };
  }, [isClient, theme, customThemes, sharedThemes]);

  // Code theme loading (single theme)
  useEffect(() => {
    if (!isClient) return;

    const codeThemeUrl = `https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/${codeTheme}.min.css`;

    // Remove existing code theme stylesheet if present
    if (codeThemeStyleRef.current) {
      codeThemeStyleRef.current.remove();
    }

    // Create new link element for code theme
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = codeThemeUrl;
    link.id = 'reveal-code-theme-dynamic';

    document.head.appendChild(link);
    codeThemeStyleRef.current = link;

    return () => {
      // Clean up code theme stylesheet on unmount
      if (codeThemeStyleRef.current) {
        codeThemeStyleRef.current.remove();
        codeThemeStyleRef.current = null;
      }
    };
  }, [isClient, codeTheme]);

  // Parse slide content (either from server or client fetch)
  useEffect(() => {
    if (!isClient) return;

    const parseContent = (html) => {
      // Extract just the slides content from the HTML
      // We need the content inside .slides, not the full HTML document
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const slidesContent = doc.querySelector('.slides');

      // Extract theme data attributes from .reveal div
      const revealDiv = doc.querySelector('.reveal');
      if (revealDiv) {
        // Single theme (check data-theme first, fallback to data-theme-light for backwards compat)
        const extractedTheme = revealDiv.getAttribute('data-theme')
          || revealDiv.getAttribute('data-theme-light')
          || 'white';
        const extractedCodeTheme = revealDiv.getAttribute('data-code-theme')
          || revealDiv.getAttribute('data-code-theme-light')
          || 'github';
        setTheme(extractedTheme);
        setCodeTheme(extractedCodeTheme);
        onThemeChange?.({ theme: extractedTheme, codeTheme: extractedCodeTheme });
      }

      const container = slidesContent || doc.body;

      // Clean up any contenteditable attributes that may have been saved
      // (these are only added at runtime during edit mode)
      container.querySelectorAll('[contenteditable]').forEach(el => {
        el.removeAttribute('contenteditable');
      });

      // When editing, strip highlight.js spans from code blocks
      // This allows clean editing - highlighting will be re-applied on save/view
      if (isEditing) {
        container.querySelectorAll('pre code').forEach(codeEl => {
          // Get plain text content (strips all HTML tags)
          const plainText = codeEl.textContent || '';
          // Escape HTML to prevent code from being interpreted as actual HTML
          // (textContent returns decoded chars like <, setting innerHTML would interpret them)
          const escaped = plainText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          codeEl.innerHTML = escaped;
          // Remove hljs class
          codeEl.classList.remove('hljs');
        });
      }

      setHtmlContent(container.innerHTML);
      setLoading(false);
    };

    // Use server-side pre-fetched content if available (avoids CORS)
    if (initialContent) {
      parseContent(initialContent);
      return;
    }

    // Fallback to client-side fetch (may fail due to CORS)
    const fetchContent = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(contentUrl);
        if (!response.ok) {
          throw new Error(`Failed to load slides: ${response.status}`);
        }

        const html = await response.text();
        parseContent(html);
      } catch (err) {
        console.error('Error loading slides:', err);
        setError(err.message);
        setLoading(false);
      }
    };

    if (contentUrl && !initialError) {
      fetchContent();
    }
  }, [isClient, contentUrl, initialContent, initialError, isEditing]);

  // Initialize Reveal.js when content is loaded (client-side only)
  // IMPORTANT: We set innerHTML here, NOT in JSX, to prevent React from
  // overwriting Reveal.js's DOM modifications during reconciliation
  useEffect(() => {
    if (!isClient || !htmlContent || !deckRef.current) return;

    let mounted = true;

    const initReveal = async () => {
      // Dynamically import Reveal.js and highlight plugin (client-side only)
      const [{ default: Reveal }, { default: RevealHighlight }] = await Promise.all([
        import('reveal.js'),
        import('reveal.js/plugin/highlight/highlight'),
      ]);

      if (!mounted || !deckRef.current) return;

      // Destroy previous instance if exists
      if (revealRef.current) {
        revealRef.current.destroy();
      }

      // Set the slides content BEFORE initializing Reveal.js
      // This is done here instead of JSX to prevent React reconciliation
      // from overwriting Reveal.js's DOM modifications during navigation
      const slidesContainer = deckRef.current.querySelector('.slides');
      if (slidesContainer) {
        slidesContainer.innerHTML = htmlContent;
      }

      // Initialize Reveal.js
      // NOTE: When editing, we exclude RevealHighlight plugin so code stays as plain text
      // This allows clean contenteditable editing. Re-highlighting happens on blur via
      // CodeBlockProperties or when saving/viewing.
      const deck = new Reveal(deckRef.current, {
        hash: true,
        history: true,
        controls: true,
        progress: true,
        center: true,
        transition: 'slide',
        // Disable keyboard when editing to allow normal text editing
        keyboard: !isEditing,
        // Touch gestures
        touch: !isEditing,
        // Disable cursor auto-hide in edit and view mode (only used in presenter mode)
        // CSS in global.css ensures cursor visibility; this prevents unnecessary listeners
        hideInactiveCursor: false,
        // Syntax highlighting for code blocks (disabled in edit mode for clean editing)
        plugins: isEditing ? [] : [RevealHighlight],
      });

      await deck.initialize();

      if (!mounted) {
        deck.destroy();
        return;
      }

      revealRef.current = deck;

      // If editing, make slides contenteditable and attach input handlers
      if (isEditing) {
        // Add editing-mode class to the reveal container for grid overlay
        deckRef.current.classList.add('editing-mode');

        const slides = deckRef.current.querySelectorAll('section');
        slides.forEach(slide => {
          slide.setAttribute('contenteditable', 'true');
          // Add editing-mode class for sl-block visual feedback
          slide.classList.add('editing-mode');
          // Add visual indicator for hidden slides
          if (slide.dataset.hidden === 'true') {
            slide.classList.add('slide-hidden');
          }
          slide.addEventListener('input', () => {
            onContentChange?.();
          });
        });

        // Handle Tab and Enter in code blocks
        // We attach to the deck because contenteditable is on <section>, not <code>
        // Events bubble up, so we catch them here and check if cursor is in a code block
        const handleKeyDown = (event) => {
          if (event.key !== 'Tab' && event.key !== 'Enter') return;

          // Check if the selection is inside a code block
          const selection = window.getSelection();
          if (!selection || !selection.rangeCount) return;

          const range = selection.getRangeAt(0);
          const startNode = range.startContainer;

          // Find the code element - check parent chain for <code> inside <pre>
          /** @type {HTMLElement | null} */
          let codeElement = null;
          if (startNode.nodeType === Node.TEXT_NODE) {
            // Text node - check parent element
            codeElement = /** @type {HTMLElement | null} */ (startNode.parentElement?.closest('pre code'));
          } else if (startNode.nodeType === Node.ELEMENT_NODE) {
            // Element node - check self or parents
            codeElement = /** @type {HTMLElement | null} */ (/** @type {Element} */ (startNode).closest('pre code'));
          }

          if (!codeElement) return;

          // Handle the key event for code blocks
          if (event.key === 'Tab') {
            handleCodeBlockTab(event, codeElement, onContentChange);
          } else if (event.key === 'Enter') {
            handleCodeBlockEnter(event, codeElement, onContentChange);
          }
        };

        deckRef.current.addEventListener('keydown', handleKeyDown);
      }
    };

    initReveal();

    return () => {
      mounted = false;
      if (revealRef.current) {
        revealRef.current.destroy();
        revealRef.current = null;
      }
    };
  }, [isClient, htmlContent, isEditing, onContentChange]);

  // Get current HTML content from the editor (cleaned up for saving)
  // Returns the full .reveal wrapper with data attributes so themes are persisted
  const getCurrentContent = useCallback(() => {
    if (!deckRef.current) return null;
    const slidesDiv = deckRef.current.querySelector('.slides');
    if (!slidesDiv) return null;

    // Clone the slides to clean up without affecting the live DOM
    const slidesClone = slidesDiv.cloneNode(true);

    // Remove contenteditable attributes added during editing
    // These shouldn't be persisted to the saved HTML
    slidesClone.querySelectorAll('[contenteditable]').forEach(el => {
      el.removeAttribute('contenteditable');
    });

    // Strip highlight.js spans from code blocks - save plain text only
    // This ensures clean HTML that can be re-highlighted on view
    slidesClone.querySelectorAll('pre code').forEach(codeEl => {
      const plainText = codeEl.textContent || '';
      // Escape HTML to preserve code content correctly
      // (textContent returns decoded chars like <, setting innerHTML would interpret them)
      const escaped = plainText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      codeEl.innerHTML = escaped;
      codeEl.classList.remove('hljs');
    });

    // Clean up Sandpack sl-blocks - the entire sl-block-content needs to be rebuilt
    // When Sandpack renders, it can create text nodes and other content throughout the block
    // We rebuild the entire structure to ensure only clean HTML is saved
    slidesClone.querySelectorAll('.sl-block[data-block-type="sandpack"]').forEach(block => {
      const embed = block.querySelector('.sandpack-embed');
      const scriptTag = embed?.querySelector('script[data-sandpack-files]');

      // Remove invalid blocks (no sandpack-embed or no script tag)
      // These can be created by corrupted save/load cycles
      if (!embed || !scriptTag) {
        block.remove();
        return;
      }

      // Extract the JSON content and all data attributes
      const filesJson = scriptTag.textContent;
      const template = embed.dataset.template || 'vanilla';
      const theme = embed.dataset.theme || 'auto';
      const layout = embed.dataset.layout || 'preview-right';
      const showTabs = embed.dataset.showTabs;
      const showLineNumbers = embed.dataset.showLineNumbers;
      const showConsole = embed.dataset.showConsole;
      const readOnly = embed.dataset.readOnly;
      const editorWidth = embed.dataset.editorWidth;

      // Rebuild sl-block-content with clean sandpack-embed
      const contentDiv = block.querySelector('.sl-block-content');
      if (contentDiv) {
        // Build data attributes string
        let dataAttrs = `data-template="${template}" data-theme="${theme}" data-layout="${layout}"`;
        if (showTabs === 'false') dataAttrs += ' data-show-tabs="false"';
        if (showLineNumbers === 'false') dataAttrs += ' data-show-line-numbers="false"';
        if (showConsole === 'true') dataAttrs += ' data-show-console="true"';
        if (readOnly === 'true') dataAttrs += ' data-read-only="true"';
        if (editorWidth && editorWidth !== '50') dataAttrs += ` data-editor-width="${editorWidth}"`;

        // Escape </script> in JSON to prevent innerHTML parsing issues
        // The JSON may contain </script> tags (e.g., in HTML file content)
        // which would prematurely close our script tag when parsed
        const safeJson = filesJson.replace(/<\/script>/gi, '<\\/script>');

        // Replace entire content with clean HTML
        contentDiv.innerHTML = `<div class="sandpack-embed" ${dataAttrs}><script type="application/json" data-sandpack-files>${safeJson}</script></div>`;
      }
    });

    // Remove any Reveal.js runtime classes/attributes that shouldn't be saved
    slidesClone.querySelectorAll('.present, .past, .future').forEach(el => {
      el.classList.remove('present', 'past', 'future');
    });

    // Build data attributes for theme settings (single theme)
    const revealDiv = deckRef.current;
    const dataAttrs = [];
    if (revealDiv.hasAttribute('data-theme')) {
      dataAttrs.push(`data-theme="${revealDiv.getAttribute('data-theme')}"`);
    }
    if (revealDiv.hasAttribute('data-code-theme')) {
      dataAttrs.push(`data-code-theme="${revealDiv.getAttribute('data-code-theme')}"`);
    }

    // Extract ONLY the <section> elements, ignoring any nested wrapper divs
    // This fixes corrupted HTML that has nested <div class="reveal/slides"> from previous bugs
    const allSections = slidesClone.querySelectorAll('section');
    // Filter to get only "root" sections (sections not nested inside other sections)
    // Vertical slide children ARE nested in a parent section, so they stay grouped correctly
    const rootSections = Array.from(allSections).filter(section => {
      return !section.parentElement.closest('section');
    });
    const sectionsHtml = rootSections.map(s => s.outerHTML).join('\n');

    // Return a thin wrapper with data attributes + slide sections
    // generateSlideHtml() extracts themes via regex, then uses just the sections
    const attrsStr = dataAttrs.length > 0 ? ' ' + dataAttrs.join(' ') : '';
    return `<div class="slides"${attrsStr}>\n${sectionsHtml}\n</div>`;
  }, []);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    getCurrentContent,
    getRevealInstance: () => revealRef.current,
    // Theme getters and setters (simplified - single theme)
    getThemes: () => ({
      theme,
      codeTheme,
    }),
    /** @param {{ theme?: string, codeTheme?: string }} newThemes */
    setThemes: (newThemes) => {
      if (newThemes.theme) setTheme(newThemes.theme);
      if (newThemes.codeTheme) setCodeTheme(newThemes.codeTheme);
      // Update data attributes on the reveal div
      if (deckRef.current) {
        if (newThemes.theme) deckRef.current.setAttribute('data-theme', newThemes.theme);
        if (newThemes.codeTheme) deckRef.current.setAttribute('data-code-theme', newThemes.codeTheme);
      }
      onContentChange?.();
    },
  }), [getCurrentContent, theme, codeTheme, onContentChange]);

  // SSR placeholder and loading state
  if (!isClient || loading) {
    return (
      <div className="reveal-loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white" />
        <p className="mt-4 text-gray-500 dark:text-gray-400">Loading slides...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="reveal-error">
        <div className="text-red-500 text-lg mb-2">Failed to load slides</div>
        <p className="text-gray-500 dark:text-gray-400">{error}</p>
        <p className="text-sm text-gray-400 mt-4">URL: {contentUrl}</p>
      </div>
    );
  }

  return (
    <div
      className="reveal"
      ref={deckRef}
      data-theme={theme}
      data-code-theme={codeTheme}
    >
      {/* NOTE: We render an empty .slides container here. The actual content
          is set via innerHTML in the useEffect to prevent React from
          overwriting Reveal.js's DOM modifications during slide navigation */}
      <div className="slides" />
    </div>
  );
});

export default RevealSlides;
