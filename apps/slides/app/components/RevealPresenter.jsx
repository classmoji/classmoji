import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { io } from 'socket.io-client';
import { IconUsers } from '@tabler/icons-react';
import QRCodeOverlay from './QRCodeOverlay';

// Configure marked for speaker notes (simple, safe rendering)
marked.setOptions({
  breaks: true,  // Convert \n to <br>
  gfm: true,     // GitHub Flavored Markdown
});

// Built-in Reveal.js themes
const BUILTIN_THEMES = ['black', 'white', 'league', 'beige', 'night', 'serif', 'simple', 'solarized', 'moon', 'dracula', 'sky', 'blood'];

/**
 * Get the URL for a theme stylesheet
 * @param {string} theme - Theme name or custom path
 * @returns {string | null} Full URL to the theme CSS, or null for shared themes
 */
function getThemeUrl(theme) {
  // Shared themes are loaded via their embedded CSS links, not dynamically
  if (theme.startsWith('shared:')) {
    return null;
  }
  if (BUILTIN_THEMES.includes(theme)) {
    return `https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/${theme}.css`;
  }
  // Custom themes are relative paths
  return theme;
}

/**
 * RevealPresenter - Full-screen presentation mode for Reveal.js
 *
 * Features:
 * - Full-screen presentation without navbar
 * - Keyboard controls (arrows, space, escape)
 * - Dynamic theme loading based on system preference
 * - Optional multiplex support for syncing with followers
 */
export default function RevealPresenter({
  contentUrl,
  initialContent = null,  // Pre-fetched content from server (bypasses CORS)
  initialError = null,    // Error from server-side fetch
  slideId,
  isPresenter = false,
  shareCode = null,       // Share code for public follow links (unauthenticated)
  previewMode = false,    // Preview mode: no socket, no controls (for speaker view previews)
  multiplexId,
  multiplexSecret,
}) {
  const deckRef = useRef(null);
  const revealRef = useRef(null);
  const socketRef = useRef(null);
  const isRemoteUpdateRef = useRef(false);  // Prevent socket event loops
  const [loading, setLoading] = useState(!initialContent && !initialError);
  const [error, setError] = useState(initialError);
  const [htmlContent, setHtmlContent] = useState(null);
  const [isClient, setIsClient] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [showFollowQR, setShowFollowQR] = useState(false);
  const [showControlQR, setShowControlQR] = useState(false);
  const [isRevealReady, setIsRevealReady] = useState(false);

  // Theme state - supports both single theme (new) and dual light/dark (legacy)
  const [theme, setTheme] = useState('white');
  const [themeLight, setThemeLight] = useState('white');
  const [themeDark, setThemeDark] = useState('black');
  const themeStyleRef = useRef(null);
  // Shared theme state - CSS URLs extracted from HTML head
  const sharedThemeLinksRef = useRef(/** @type {HTMLLinkElement[]} */ ([]));
  const [bodyClasses, setBodyClasses] = useState('');

  // Hydration check
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Dynamic theme loading based on system color scheme
  // For shared themes, CSS is loaded via embedded links (no dynamic loading needed)
  useEffect(() => {
    if (!isClient) return;

    // Shared themes have their CSS embedded in the HTML head - no dynamic loading
    // Just apply body classes and let the embedded CSS handle styling
    if (theme.startsWith('shared:')) {
      // Apply body classes for shared theme
      if (bodyClasses) {
        const classes = bodyClasses.split(' ').filter(c => c.trim());
        document.body.classList.add(...classes);
      }

      // Load the shared theme CSS links that we extracted from HTML
      sharedThemeLinksRef.current.forEach(link => {
        if (!document.head.contains(link)) {
          document.head.appendChild(link);
        }
      });

      // Recalculate layout after CSS loads
      setTimeout(() => {
        if (revealRef.current) {
          revealRef.current.layout();
        }
      }, 100);

      return () => {
        // Clean up body classes
        if (bodyClasses) {
          const classes = bodyClasses.split(' ').filter(c => c.trim());
          document.body.classList.remove(...classes);
        }
        // Remove shared theme links
        sharedThemeLinksRef.current.forEach(link => link.remove());
      };
    }

    // Built-in themes: Create or update theme stylesheet link
    /** @param {boolean} isDark */
    const loadTheme = (isDark) => {
      const currentTheme = isDark ? themeDark : themeLight;
      const themeUrl = getThemeUrl(currentTheme);

      // Remove existing theme stylesheet if present
      if (themeStyleRef.current) {
        themeStyleRef.current.remove();
      }

      // Skip if no theme URL (shouldn't happen for built-in themes)
      if (!themeUrl) return;

      // Create new link element for theme
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = themeUrl;
      link.id = 'reveal-theme-dynamic';

      // Recalculate Reveal.js layout after theme CSS loads
      // Different themes have different fonts/sizes that affect slide dimensions
      link.onload = () => {
        if (revealRef.current) {
          revealRef.current.layout();
        }
      };

      document.head.appendChild(link);
      themeStyleRef.current = link;
    };

    // Check initial preference and load theme
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    loadTheme(mediaQuery.matches);

    // Listen for changes to system preference
    /** @param {MediaQueryListEvent} e */
    const handleChange = (e) => {
      loadTheme(e.matches);
    };
    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
      // Clean up theme stylesheet on unmount
      if (themeStyleRef.current) {
        themeStyleRef.current.remove();
        themeStyleRef.current = null;
      }
    };
  }, [isClient, theme, themeLight, themeDark, bodyClasses]);

  // Parse slide content (either from server or client fetch)
  useEffect(() => {
    if (!isClient) return;

    const parseContent = (html) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const slidesContent = doc.querySelector('.slides');

      // Extract theme data attributes from .reveal div
      // Supports both new single theme (data-theme) and legacy dual theme (data-theme-light/dark)
      const revealDiv = doc.querySelector('.reveal');
      if (revealDiv) {
        const singleTheme = revealDiv.getAttribute('data-theme');
        if (singleTheme) {
          // New single-theme system
          setTheme(singleTheme);
          // For backwards compat with theme loading, set light/dark to same value
          setThemeLight(singleTheme);
          setThemeDark(singleTheme);
        } else {
          // Legacy dual-theme system
          const light = revealDiv.getAttribute('data-theme-light') || 'white';
          const dark = revealDiv.getAttribute('data-theme-dark') || 'black';
          setTheme(light); // Use light as default
          setThemeLight(light);
          setThemeDark(dark);
        }
      }

      // Extract body classes from the HTML
      const bodyEl = doc.querySelector('body');
      if (bodyEl && bodyEl.className) {
        setBodyClasses(bodyEl.className);
      }

      // For shared themes, extract CSS links from the HTML head
      // These are the lib CSS and custom theme CSS that were embedded during save
      const headLinks = doc.querySelectorAll('head link[rel="stylesheet"]');
      const sharedLinks = [];
      headLinks.forEach((link) => {
        const href = link.getAttribute('href');
        // Include content proxy URLs (shared theme CSS) but not CDN URLs
        if (href && href.includes('/content/') && href.includes('.slidesthemes/')) {
          const newLink = document.createElement('link');
          newLink.rel = 'stylesheet';
          newLink.href = href;
          sharedLinks.push(newLink);
        }
      });
      sharedThemeLinksRef.current = sharedLinks;

      if (slidesContent) {
        // Filter out hidden slides (data-hidden="true") for presentation
        // Hidden slides are only visible in edit mode
        let content = slidesContent.innerHTML;

        // Create a temp container to manipulate the DOM
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = content;

        // Remove hidden sections
        tempContainer.querySelectorAll('section[data-hidden="true"]').forEach(el => el.remove());

        // Clean up empty vertical stacks (parent sections that only contained hidden slides)
        tempContainer.querySelectorAll(':scope > section').forEach(section => {
          const nestedSections = section.querySelectorAll(':scope > section');
          // If this was a vertical stack and all children were removed, remove the parent too
          if (nestedSections.length === 0 && !section.innerHTML.trim()) {
            section.remove();
          }
        });

        content = tempContainer.innerHTML;

        // Check if any slides remain
        if (!content.trim() || !tempContainer.querySelector('section')) {
          setError('All slides are hidden. At least one visible slide is required to present.');
          setLoading(false);
          return;
        }

        setHtmlContent(content);
      } else {
        setHtmlContent(doc.body.innerHTML);
      }
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
  }, [isClient, contentUrl, initialContent, initialError]);

  // Initialize Reveal.js in presentation mode
  // IMPORTANT: We set innerHTML here, NOT in JSX, to prevent React from
  // overwriting Reveal.js's DOM modifications during reconciliation
  useEffect(() => {
    if (!isClient || !htmlContent || !deckRef.current) return;

    let mounted = true;

    const initReveal = async () => {
      const [{ default: Reveal }, { default: RevealHighlight }, { default: RevealNotes }] = await Promise.all([
        import('reveal.js'),
        import('reveal.js/plugin/highlight/highlight'),
        import('reveal.js/plugin/notes/notes'),
      ]);

      if (!mounted || !deckRef.current) return;

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

      const config = {
        hash: true,
        history: true,
        // In preview mode, hide all UI elements - the slide content fills the frame
        controls: !previewMode,
        progress: !previewMode,
        center: true,
        transition: previewMode ? 'none' : 'slide',  // No transitions in preview
        // Presentation-specific settings
        keyboard: !previewMode,  // Disable keyboard nav in preview iframes
        overview: false,  // Disabled in presenter mode - ESC exits directly
        touch: !previewMode,
        loop: false,
        autoSlide: 0,
        // Show slide number (except in preview mode)
        slideNumber: previewMode ? false : 'c/t',
        // Hide controls after 3 seconds of inactivity
        controlsAutoHide: true,
        // Plugins: syntax highlighting + speaker notes support (but not built-in popup)
        // We include RevealNotes for markdown processing of <aside class="notes">,
        // but disable the 'S' keyboard shortcut to use our custom /speaker route instead
        plugins: [RevealHighlight, RevealNotes],
      };

      const deck = new Reveal(deckRef.current, config);
      await deck.initialize();

      if (!mounted) {
        deck.destroy();
        return;
      }

      // Process speaker notes: convert markdown to HTML for speaker view
      // This must happen after initialization so the notes are in the DOM
      const notesElements = deckRef.current.querySelectorAll('aside.notes');
      notesElements.forEach((aside) => {
        const markdownContent = aside.textContent || '';
        if (markdownContent.trim()) {
          // Convert markdown to HTML using marked
          aside.innerHTML = marked.parse(markdownContent);
        }
      });

      revealRef.current = deck;
      setIsRevealReady(true);
    };

    initReveal();

    return () => {
      mounted = false;
      setIsRevealReady(false);
      if (revealRef.current) {
        revealRef.current.destroy();
        revealRef.current = null;
      }
    };
  }, [isClient, htmlContent, isPresenter, previewMode]);

  // Socket.IO connection for real-time slide sync (skip in preview mode)
  useEffect(() => {
    if (!isRevealReady || !revealRef.current || !slideId || previewMode) return;

    const deck = revealRef.current;

    // Connect to multiplex namespace
    const socketQuery = shareCode ? { shareCode } : {};
    const socket = io('/multiplex', {
      path: '/socket.io',
      withCredentials: true,
      query: socketQuery,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[socket] Connected to multiplex server');
      // Join the presentation room
      socket.emit('join', { slideId });
    });

    socket.on('connect_error', (err) => {
      console.error('[socket] Connection error:', err.message);
    });

    // Listen for viewer count updates
    socket.on('viewercount', ({ count }) => {
      setViewerCount(count);
    });

    // Handle current state for late joiners (catch-up to presenter's position)
    socket.on('currentstate', (data) => {
      console.log('[socket] Received current state - catching up to:', data);
      const current = deck.getIndices();
      if (current.h !== data.indexh || current.v !== data.indexv) {
        isRemoteUpdateRef.current = true;
        deck.slide(data.indexh, data.indexv);
        setTimeout(() => {
          isRemoteUpdateRef.current = false;
        }, 100);
      }
    });

    // If presenter, broadcast slide changes
    if (isPresenter) {
      const handleSlideChanged = (event) => {
        // Skip if this was triggered by a remote update (loop prevention)
        if (isRemoteUpdateRef.current) return;
        socket.emit('slidechanged', {
          indexh: event.indexh,
          indexv: event.indexv,
        });
      };

      const handleFragmentShown = (event) => {
        if (isRemoteUpdateRef.current) return;
        socket.emit('fragmentshown', {
          index: event.fragment.dataset.fragmentIndex,
          indexh: deck.getIndices().h,
          indexv: deck.getIndices().v,
        });
      };

      const handleFragmentHidden = (event) => {
        if (isRemoteUpdateRef.current) return;
        socket.emit('fragmenthidden', {
          index: event.fragment.dataset.fragmentIndex,
          indexh: deck.getIndices().h,
          indexv: deck.getIndices().v,
        });
      };

      deck.on('slidechanged', handleSlideChanged);
      deck.on('fragmentshown', handleFragmentShown);
      deck.on('fragmenthidden', handleFragmentHidden);
    }

    // Listen for slide changes from presenter (or other devices if bidirectional)
    socket.on('slidechanged', (data) => {
      const current = deck.getIndices();
      // Only navigate if different from current position
      if (current.h !== data.indexh || current.v !== data.indexv) {
        isRemoteUpdateRef.current = true;
        deck.slide(data.indexh, data.indexv);
        // Reset flag after Reveal.js processes the slide change
        setTimeout(() => {
          isRemoteUpdateRef.current = false;
        }, 100);
      }
    });

    socket.on('fragmentshown', (data) => {
      isRemoteUpdateRef.current = true;
      deck.slide(data.indexh, data.indexv, parseInt(data.index, 10));
      setTimeout(() => {
        isRemoteUpdateRef.current = false;
      }, 100);
    });

    socket.on('fragmenthidden', (data) => {
      isRemoteUpdateRef.current = true;
      // Navigate to the slide and let Reveal.js handle fragment state
      deck.slide(data.indexh, data.indexv);
      setTimeout(() => {
        isRemoteUpdateRef.current = false;
      }, 100);
    });

    // Listen for remote QR display requests from speaker view
    if (isPresenter) {
      socket.on('showqr', ({ type }) => {
        if (type === 'follow') {
          setShowFollowQR(true);
        } else if (type === 'speaker') {
          setShowControlQR(true);
        }
      });

      socket.on('hideqr', () => {
        setShowFollowQR(false);
        setShowControlQR(false);
      });
    }

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isRevealReady, slideId, isPresenter, shareCode, previewMode]);

  // Handle keyboard shortcuts
  // Uses capture phase to intercept 'S' before Reveal.js's built-in speaker view handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't handle shortcuts if typing in an input
      if (e.target.matches('input, textarea')) return;

      if (e.key === 'Escape') {
        // Close QR overlay if open, otherwise exit presentation
        if (showFollowQR || showControlQR) {
          setShowFollowQR(false);
          setShowControlQR(false);
        } else if (!document.fullscreenElement) {
          window.location.href = `/${slideId}`;
        }
      } else if (e.key === 'q' || e.key === 'Q') {
        // Toggle follow QR code (only in presenter mode)
        if (isPresenter) {
          setShowFollowQR(prev => !prev);
        }
      } else if ((e.key === 's' || e.key === 'S') && isPresenter) {
        // Intercept 'S' to open our custom speaker view instead of Reveal.js's built-in one
        // Our speaker view has bidirectional socket sync, which the built-in one lacks
        e.preventDefault();
        e.stopPropagation();
        window.open(`/${slideId}/speaker`, '_blank', 'width=1000,height=700');
      }
    };

    // Use capture phase to intercept before Reveal.js sees the event
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [slideId, isPresenter, showFollowQR, showControlQR]);

  if (!isClient || loading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto" />
          <p className="mt-4 text-white/60">Loading presentation...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="text-center text-white">
          <div className="text-red-400 text-lg mb-2">Failed to load presentation</div>
          <p className="text-white/60">{error}</p>
          <button
            onClick={() => window.location.href = `/${slideId}`}
            className="mt-4 px-4 py-2 bg-white/10 rounded-sm hover:bg-white/20"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  // Build URLs for QR codes
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const followUrl = multiplexId
    ? `${baseUrl}/${slideId}/follow?shareCode=${multiplexId}`
    : `${baseUrl}/${slideId}/follow`;
  const speakerUrl = `${baseUrl}/${slideId}/speaker`;

  return (
    <>
      {/* Keyboard hints - uses theme's main color variable for visibility on any theme */}
      <div
        className="fixed top-4 right-4 z-50 text-sm pointer-events-none opacity-40"
        style={{ color: 'var(--r-main-color, white)' }}
      >
        {isPresenter ? 'Press S for speaker view • Q for share QR • ESC to exit' : 'ESC to exit'}
      </div>

      {/* Viewer count - transparent overlay in top right (presenter mode only) */}
      {isPresenter && viewerCount > 0 && (
        <div
          className="fixed top-4 left-4 z-40 flex items-center gap-1.5 text-sm pointer-events-none opacity-50"
          style={{ color: 'var(--r-main-color, white)' }}
        >
          <IconUsers size={16} />
          <span>{viewerCount}</span>
        </div>
      )}

      {/* Audience viewer count indicator */}
      {!isPresenter && viewerCount > 0 && (
        <div className="fixed bottom-4 right-4 z-40 bg-gray-800/80 text-white px-3 py-1.5 rounded-lg shadow-lg flex items-center gap-2 text-sm">
          <IconUsers size={16} />
          <span>{viewerCount} watching</span>
        </div>
      )}

      {/* QR Code Overlays */}
      {showFollowQR && (
        <QRCodeOverlay
          url={followUrl}
          title="Scan to Follow Along"
          onClose={() => setShowFollowQR(false)}
        />
      )}

      {showControlQR && (
        <QRCodeOverlay
          url={speakerUrl}
          title="Scan to Control from Phone"
          onClose={() => setShowControlQR(false)}
        />
      )}

      {/* Reveal.js container - NOTE: We render an empty .slides container here.
          The actual content is set via innerHTML in the useEffect to prevent
          React from overwriting Reveal.js's DOM modifications during navigation */}
      <div
        className="reveal"
        ref={deckRef}
        style={{ height: '100vh' }}
        data-theme-light={themeLight}
        data-theme-dark={themeDark}
      >
        <div className="slides" />
      </div>
    </>
  );
}
