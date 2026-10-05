import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { handleCodeBlockTab, handleCodeBlockEnter } from './properties/utils/codeBlockUtils';
import {
  neutralizeHtmlBlockFrames,
  sanitizeSvgBlocks,
} from '@classmoji/services/slides/runtime-attrs';
import { domSlideTree, removeHiddenSlides } from '@classmoji/services/slides/hidden';
import { stripMediaRefs } from '~/utils/mediaRefs';
import { cleanupEditorContainer } from '~/utils/editorCleanup';
import { lockSourceBlockContent } from '~/utils/collab/bridgeDom';

// Built-in Reveal.js themes (exported for use in SlideToolbar)
export const BUILTIN_THEMES = [
  'black',
  'white',
  'league',
  'beige',
  'night',
  'serif',
  'simple',
  'solarized',
  'moon',
  'dracula',
  'sky',
  'blood',
];

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
interface CustomTheme {
  id: string;
  cssUrl?: string;
}

interface SharedTheme {
  id: string;
  libCssUrl?: string;
  bodyClasses?: string;
  customThemeUrl?: string;
}

interface RevealSlidesProps {
  contentUrl?: string;
  initialContent?: string | null;
  initialError?: string | null;
  canEdit?: boolean;
  isEditing?: boolean;
  onContentChange?: () => void;
  onThemeChange?: (themes: { theme: string; codeTheme: string }) => void;
  /**
   * Called with the Reveal.js instance once `initialize()` resolves, and with
   * null when that instance is destroyed. Initialization is async (two dynamic
   * imports, then initialize), so this is the only reliable signal that the
   * instance exists — reading the ref after a fixed delay loses the race on
   * large decks and leaves the caller holding null for good.
   */
  onRevealReady?: (deck: RevealApi | null) => void;
  customThemes?: CustomTheme[];
  sharedThemes?: SharedTheme[];
  /** Live editing: whether a section may be made editable (false = someone else holds it). */
  sectionEditable?: (section: Element) => boolean;
}

export interface RevealSlidesHandle {
  getCurrentContent: () => string | null;
  getRevealInstance: () => RevealApi | null;
  getThemes: () => { theme: string; codeTheme: string };
  setThemes: (newThemes: { theme?: string; codeTheme?: string }) => void;
}

function getThemeUrl(
  theme: string,
  customThemes: CustomTheme[] = [],
  sharedThemes: SharedTheme[] = []
) {
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
const RevealSlides = forwardRef(function RevealSlides(
  {
    contentUrl,
    initialContent = null, // Pre-fetched content from server (bypasses CORS)
    initialError = null, // Error from server-side fetch
    canEdit: _canEdit = false,
    isEditing = false,
    onContentChange,
    onThemeChange, // Callback when themes are extracted from content
    onRevealReady,
    customThemes = [], // Custom themes with cssUrl for loading
    sharedThemes = [], // Shared themes from slides.com imports (with lib/ folder)
    sectionEditable,
  }: RevealSlidesProps,
  ref: React.Ref<RevealSlidesHandle>
) {
  const deckRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<RevealApi | null>(null);
  // Held in a ref so a new callback identity never re-runs the init effect
  // below (which would destroy and rebuild the deck).
  const onRevealReadyRef = useRef(onRevealReady);
  onRevealReadyRef.current = onRevealReady;
  const sectionEditableRef = useRef(sectionEditable);
  sectionEditableRef.current = sectionEditable;
  const [loading, setLoading] = useState(!initialContent && !initialError);
  const [error, setError] = useState(initialError);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [isClient, setIsClient] = useState(false);

  // Theme state - single theme (no light/dark mode split for simplicity)
  const [theme, setTheme] = useState('white');
  const [codeTheme, setCodeTheme] = useState('github');
  const themeStyleRef = useRef<HTMLLinkElement | null>(null);
  const codeThemeStyleRef = useRef<HTMLLinkElement | null>(null);
  // Track custom theme CSS link (for shared themes with custom-theme.css)
  const customThemeStyleRef = useRef<HTMLLinkElement | null>(null);
  // Track body classes added by shared themes
  const sharedThemeBodyClassesRef = useRef<string[]>([]);

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
          const classes = sharedTheme.bodyClasses.split(' ').filter((c: string) => c.trim());
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

    const parseContent = (html: string) => {
      // Extract just the slides content from the HTML
      // We need the content inside .slides, not the full HTML document
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const slidesContent = doc.querySelector('.slides');

      // Extract theme data attributes from .reveal div
      const revealDiv = doc.querySelector('.reveal');
      if (revealDiv) {
        // Single theme (check data-theme first, fallback to data-theme-light for backwards compat)
        const extractedTheme =
          revealDiv.getAttribute('data-theme') ||
          revealDiv.getAttribute('data-theme-light') ||
          'white';
        const extractedCodeTheme =
          revealDiv.getAttribute('data-code-theme') ||
          revealDiv.getAttribute('data-code-theme-light') ||
          'github';
        setTheme(extractedTheme);
        setCodeTheme(extractedCodeTheme);
        onThemeChange?.({ theme: extractedTheme, codeTheme: extractedCodeTheme });
      }

      const container = slidesContent || doc.body;

      // Hidden slides are how a deck retires content without deleting it. This
      // is the viewer every non-editor lands on (the plain /{slideId} view,
      // students included), so it applies the same rule as the presenter
      // (hiddenSlides.ts, #436). Editing keeps them in the DOM, marked via
      // .slide-hidden below, so the teaching team can find and restore them,
      // and a save (which reads the editor's DOM) keeps them.
      if (!isEditing) removeHiddenSlides(container, domSlideTree);

      // Clean up any contenteditable attributes that may have been saved
      // (these are only added at runtime during edit mode)
      container.querySelectorAll('[contenteditable]').forEach(el => {
        el.removeAttribute('contenteditable');
      });

      // An html block's frame loads only in its sandbox; svg blocks are held to
      // their lists (deckBlocks.ts).
      neutralizeHtmlBlockFrames(container);
      sanitizeSvgBlocks(container);

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

        const response = await fetch(contentUrl!);
        if (!response.ok) {
          throw new Error(`Failed to load slides: ${response.status}`);
        }

        const html = await response.text();
        // The stored index.html, unresolved: its `media://` references have no
        // URL here, and a browser cannot load that scheme — so a read blanks
        // them. Never in the editor, whose document goes back through a save:
        // it keeps what it loaded (and edit mode always has `initialContent`
        // from fetch-latest, so this fallback does not run there anyway).
        parseContent(isEditing ? html : stripMediaRefs(html));
      } catch (err: unknown) {
        console.error('Error loading slides:', err);
        setError(err instanceof Error ? err.message : String(err));
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
    let resizeObserver: ResizeObserver | null = null;
    let layoutRaf = 0;

    // rAF-debounced re-layout: collapse a burst of geometry changes to a
    // single deck.layout() per frame. Guarded by revealRef.current, which the
    // cleanup nulls on destroy, so a queued frame after teardown is a no-op.
    const scheduleLayout = () => {
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        revealRef.current?.layout();
      });
    };

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
      onRevealReadyRef.current?.(deck);

      // Reactive centering (the structural cure for intermittent off-center
      // slides after save): observe the .reveal container and re-layout on any
      // size change. Reveal's center:true positions each slide against the
      // container height measured at layout() time; when geometry shifts AFTER
      // that measurement — the saving scrim/strip unmounting, the edit↔view
      // chrome swap reclaiming the sidebar, a window/panel resize, or future
      // chrome — the old centering is stale and content renders pushed down.
      // Re-laying out on the actual resize makes centering track real geometry
      // instead of hoping React effects settle first. Debounced to one call
      // per frame; disconnected on unmount.
      if (typeof ResizeObserver !== 'undefined' && deckRef.current) {
        resizeObserver = new ResizeObserver(() => scheduleLayout());
        resizeObserver.observe(deckRef.current);
      }

      // If editing, make slides contenteditable and attach input handlers
      if (isEditing) {
        // Add editing-mode class to the reveal container for grid overlay
        deckRef.current.classList.add('editing-mode');

        const slides = deckRef.current.querySelectorAll('section');
        slides.forEach((slide: Element) => {
          const editable = sectionEditableRef.current?.(slide) ?? true;
          slide.setAttribute('contenteditable', editable ? 'true' : 'false');
          // Add editing-mode class for sl-block visual feedback
          slide.classList.add('editing-mode');
          // Add visual indicator for hidden slides
          if ((slide as HTMLElement).dataset?.hidden === 'true') {
            slide.classList.add('slide-hidden');
          }
          slide.addEventListener('input', () => {
            onContentChange?.();
          });
        });
        // svg and html blocks are edited from the inspector, not typed into.
        lockSourceBlockContent(deckRef.current);

        // Handle Tab and Enter in code blocks
        // We attach to the deck because contenteditable is on <section>, not <code>
        // Events bubble up, so we catch them here and check if cursor is in a code block
        const handleKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'Tab' && event.key !== 'Enter') return;

          // Check if the selection is inside a code block
          const selection = window.getSelection();
          if (!selection || !selection.rangeCount) return;

          const range = selection.getRangeAt(0);
          const startNode = range.startContainer;

          // Find the code element - check parent chain for <code> inside <pre>
          let codeElement: HTMLElement | null = null;
          if (startNode.nodeType === Node.TEXT_NODE) {
            // Text node - check parent element
            codeElement =
              (startNode.parentElement?.closest('pre code') as HTMLElement | null) ?? null;
          } else if (startNode.nodeType === Node.ELEMENT_NODE) {
            // Element node - check self or parents
            codeElement = (startNode as Element).closest('pre code') as HTMLElement | null;
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

      // Settled recalc after content adoption: deck.initialize() ran its first
      // centering layout while the container may still be mid-transition (the
      // post-save batch that swaps in the committed content ALSO exits edit
      // mode, so the scrim/strip unmount and the edit→view chrome swap happen
      // in the same frame). Re-center once the DOM has settled — a double rAF
      // (one frame to commit, one to measure) — and again after fonts load,
      // since font metrics change text height and therefore the center math.
      // `revealRef.current === deck` guards against this deck being destroyed
      // or replaced by a remount between scheduling and firing.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (revealRef.current === deck) deck.layout();
        });
      });
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        document.fonts.ready.then(() => {
          if (revealRef.current === deck) deck.layout();
        });
      }
    };

    initReveal();

    return () => {
      mounted = false;
      if (layoutRaf) cancelAnimationFrame(layoutRaf);
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (revealRef.current) {
        revealRef.current.destroy();
        revealRef.current = null;
        onRevealReadyRef.current?.(null);
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
    const slidesClone = slidesDiv.cloneNode(true) as HTMLElement;

    // Strip editor/runtime additions (contenteditable, hljs spans, the live
    // Sandpack mounts, Reveal paint). The same cleanup the diff-at-save
    // snapshot runs on both sides (deckOpsDiff), so the two always agree.
    cleanupEditorContainer(slidesClone);

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
    const rootSections = Array.from(allSections).filter((section: Element) => {
      return !section.parentElement?.closest('section');
    });
    const sectionsHtml = rootSections.map((s: Element) => s.outerHTML).join('\n');

    // Return a thin wrapper with data attributes + slide sections
    // The save action parses this via parseSlidesFragment (themes from the
    // wrapper's data attributes, sections into structured DeckSlides)
    const attrsStr = dataAttrs.length > 0 ? ' ' + dataAttrs.join(' ') : '';
    return `<div class="slides"${attrsStr}>\n${sectionsHtml}\n</div>`;
  }, []);

  // Expose methods to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      getCurrentContent,
      getRevealInstance: () => revealRef.current,
      // Theme getters and setters (simplified - single theme)
      getThemes: () => ({
        theme,
        codeTheme,
      }),
      setThemes: (newThemes: { theme?: string; codeTheme?: string }) => {
        if (newThemes.theme) setTheme(newThemes.theme);
        if (newThemes.codeTheme) setCodeTheme(newThemes.codeTheme);
        // Update data attributes on the reveal div
        if (deckRef.current) {
          if (newThemes.theme) deckRef.current.setAttribute('data-theme', newThemes.theme);
          if (newThemes.codeTheme)
            deckRef.current.setAttribute('data-code-theme', newThemes.codeTheme);
        }
        onContentChange?.();
      },
    }),
    [getCurrentContent, theme, codeTheme, onContentChange]
  );

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
    <div className="reveal" ref={deckRef} data-theme={theme} data-code-theme={codeTheme}>
      {/* NOTE: We render an empty .slides container here. The actual content
          is set via innerHTML in the useEffect to prevent React from
          overwriting Reveal.js's DOM modifications during slide navigation */}
      <div className="slides" />
    </div>
  );
});

export default RevealSlides;
