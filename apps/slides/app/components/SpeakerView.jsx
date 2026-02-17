import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';
import { marked } from 'marked';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconClockStop,
  IconDeviceMobile,
  IconMinus,
  IconPlus,
  IconQrcode,
  IconRefresh,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import QRCodeOverlay from './QRCodeOverlay';

// Configure marked for speaker notes
marked.setOptions({
  breaks: true,
  gfm: true,
});

/**
 * Format milliseconds as HH:MM:SS
 */
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Parse slides HTML to extract slide data (content, notes)
 * Filters out hidden slides (data-hidden="true") from the list
 */
function parseSlides(htmlContent) {
  if (!htmlContent) return [];

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div class="slides">${htmlContent}</div>`, 'text/html');
  const slidesContainer = doc.querySelector('.slides');
  if (!slidesContainer) return [];

  const slides = [];
  const sections = slidesContainer.querySelectorAll(':scope > section');

  sections.forEach((section, h) => {
    // Skip hidden top-level sections
    if (section.dataset.hidden === 'true') return;

    // Check for vertical slides
    const verticalSections = section.querySelectorAll(':scope > section');

    if (verticalSections.length > 0) {
      // Horizontal slide with vertical children
      verticalSections.forEach((vSection, v) => {
        // Skip hidden vertical sections
        if (vSection.dataset.hidden === 'true') return;

        const notes = vSection.querySelector('aside.notes');
        slides.push({
          h,
          v,
          content: vSection.innerHTML,
          notes: notes ? notes.textContent : null,
        });
      });
    } else {
      // Single horizontal slide
      const notes = section.querySelector('aside.notes');
      slides.push({
        h,
        v: 0,
        content: section.innerHTML,
        notes: notes ? notes.textContent : null,
      });
    }
  });

  return slides;
}

/**
 * SpeakerView - Mobile-friendly speaker notes display with navigation controls
 *
 * Features:
 * - Current and next slide preview
 * - Speaker notes display
 * - Elapsed time timer
 * - Navigation controls (prev/next)
 * - Real-time sync with other presenter windows
 */
export default function SpeakerView({
  slideId,
  initialContent,
}) {
  const socketRef = useRef(null);
  const isRemoteUpdateRef = useRef(false);
  const startTimeRef = useRef(Date.now());
  const previewContainerRef = useRef(null);

  const [currentSlide, setCurrentSlide] = useState({ h: 0, v: 0 });
  const [elapsedTime, setElapsedTime] = useState(0);
  const [viewerCount, setViewerCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [previewScale, setPreviewScale] = useState(0.5);
  const [endTime, setEndTime] = useState(null); // Target end time as Date
  const [timeRemaining, setTimeRemaining] = useState(null); // ms until end time
  const [showEndTimeInput, setShowEndTimeInput] = useState(false);
  const [notesFontSize, setNotesFontSize] = useState(1); // Font scale: 1 = 100%
  const [showPhoneQR, setShowPhoneQR] = useState(false); // Local QR for phone control
  const [remoteQRShowing, setRemoteQRShowing] = useState(false); // Track if QR is showing on presenter

  // Parse slides from HTML content
  const slides = useMemo(() => {
    if (typeof window === 'undefined') return [];
    return parseSlides(initialContent);
  }, [initialContent]);

  // Get current and next slide data
  const currentSlideData = useMemo(() => {
    return slides.find(s => s.h === currentSlide.h && s.v === currentSlide.v) || slides[0];
  }, [slides, currentSlide]);

  const nextSlideData = useMemo(() => {
    const currentIndex = slides.findIndex(s => s.h === currentSlide.h && s.v === currentSlide.v);
    if (currentIndex >= 0 && currentIndex < slides.length - 1) {
      return slides[currentIndex + 1];
    }
    return null;
  }, [slides, currentSlide]);

  const currentIndex = useMemo(() => {
    return slides.findIndex(s => s.h === currentSlide.h && s.v === currentSlide.v);
  }, [slides, currentSlide]);

  // Connect to Socket.IO
  useEffect(() => {
    const socket = io('/multiplex', {
      path: '/socket.io',
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[speaker] Connected to multiplex server');
      setIsConnected(true);
      socket.emit('join', { slideId });
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('connect_error', (err) => {
      console.error('[speaker] Connection error:', err.message);
      setIsConnected(false);
    });

    socket.on('viewercount', ({ count }) => {
      setViewerCount(count);
    });

    // Handle current state for late joiners (catch-up to presenter's position)
    socket.on('currentstate', (data) => {
      console.log('[speaker] Received current state - catching up to:', data);
      setCurrentSlide({ h: data.indexh, v: data.indexv });
    });

    // Listen for slide changes from other windows
    socket.on('slidechanged', (data) => {
      isRemoteUpdateRef.current = true;
      setCurrentSlide({ h: data.indexh, v: data.indexv });
      setTimeout(() => {
        isRemoteUpdateRef.current = false;
      }, 100);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [slideId]);

  // Load saved end time from localStorage on mount
  useEffect(() => {
    const savedEndTime = localStorage.getItem(`speaker-endtime-${slideId}`);
    if (savedEndTime) {
      const endDate = new Date(savedEndTime);
      // Only restore if it's still in the future
      if (endDate > new Date()) {
        setEndTime(endDate);
      } else {
        localStorage.removeItem(`speaker-endtime-${slideId}`);
      }
    }
  }, [slideId]);

  // Load saved notes font size from localStorage on mount
  useEffect(() => {
    const savedFontSize = localStorage.getItem('speaker-notes-fontsize');
    if (savedFontSize) {
      const size = parseFloat(savedFontSize);
      if (size >= 0.5 && size <= 2) {
        setNotesFontSize(size);
      }
    }
  }, []);

  // Timer effect - updates both elapsed and remaining time
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedTime(Date.now() - startTimeRef.current);

      // Calculate time remaining if end time is set
      if (endTime) {
        const remaining = endTime.getTime() - Date.now();
        setTimeRemaining(remaining > 0 ? remaining : 0);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [endTime]);

  // Reset timer function
  const resetTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    setElapsedTime(0);
  }, []);

  // Set end time from a time string (HH:MM format)
  const handleSetEndTime = useCallback((timeString) => {
    if (!timeString) {
      setEndTime(null);
      setTimeRemaining(null);
      localStorage.removeItem(`speaker-endtime-${slideId}`);
      return;
    }

    const [hours, minutes] = timeString.split(':').map(Number);
    const now = new Date();
    const endDate = new Date();
    endDate.setHours(hours, minutes, 0, 0);

    // If the time is earlier today, assume it's tomorrow
    if (endDate <= now) {
      endDate.setDate(endDate.getDate() + 1);
    }

    setEndTime(endDate);
    setTimeRemaining(endDate.getTime() - Date.now());
    localStorage.setItem(`speaker-endtime-${slideId}`, endDate.toISOString());
    setShowEndTimeInput(false);
  }, [slideId]);

  // Clear end time
  const clearEndTime = useCallback(() => {
    setEndTime(null);
    setTimeRemaining(null);
    localStorage.removeItem(`speaker-endtime-${slideId}`);
  }, [slideId]);

  // Zoom notes font size (0.5 to 2.0 range, 0.1 steps)
  const zoomNotesIn = useCallback(() => {
    setNotesFontSize((prev) => {
      const newSize = Math.min(prev + 0.1, 2);
      localStorage.setItem('speaker-notes-fontsize', newSize.toString());
      return newSize;
    });
  }, []);

  const zoomNotesOut = useCallback(() => {
    setNotesFontSize((prev) => {
      const newSize = Math.max(prev - 0.1, 0.5);
      localStorage.setItem('speaker-notes-fontsize', newSize.toString());
      return newSize;
    });
  }, []);

  // Format time remaining as "X min" or "X:XX"
  const formatTimeRemaining = useCallback((ms) => {
    if (ms === null || ms === undefined) return null;
    if (ms <= 0) return "Time's up!";

    const totalMinutes = Math.ceil(ms / 60000);
    if (totalMinutes >= 60) {
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      return `${hours}h ${mins}m left`;
    }
    return `${totalMinutes} min left`;
  }, []);

  // Calculate preview scale based on container width
  // Iframes render at 960px width, we scale them to fit the container
  // Layout: slides are always stacked vertically in their column
  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;

    const calculateScale = () => {
      const containerWidth = container.offsetWidth;
      // Slides are always stacked vertically now, so each slide gets full container width
      // minus padding (p-4 = 16px each side = 32px total)
      const previewWidth = containerWidth - 32;
      const scale = previewWidth / 960; // iframe is 960px wide
      setPreviewScale(Math.min(scale, 1)); // Don't scale up, only down
    };

    calculateScale();

    const resizeObserver = new ResizeObserver(calculateScale);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // Navigate to a specific slide and broadcast
  const navigateTo = useCallback((h, v) => {
    if (isRemoteUpdateRef.current) return;

    setCurrentSlide({ h, v });

    // Broadcast to other windows
    socketRef.current?.emit('slidechanged', {
      indexh: h,
      indexv: v,
    });
  }, []);

  // Compute available navigation directions
  const navigation = useMemo(() => {
    const { h, v } = currentSlide;

    // Find all unique horizontal indices
    const horizontalIndices = [...new Set(slides.map(s => s.h))].sort((a, b) => a - b);
    const currentHIndex = horizontalIndices.indexOf(h);

    // Find slides in current stack (same h)
    const currentStack = slides.filter(s => s.h === h).sort((a, b) => a.v - b.v);
    const currentVIndex = currentStack.findIndex(s => s.v === v);

    // Check which directions are available
    const canGoLeft = currentHIndex > 0;
    const canGoRight = currentHIndex < horizontalIndices.length - 1;
    const canGoUp = currentVIndex > 0;
    const canGoDown = currentVIndex < currentStack.length - 1;

    // Find target slides for each direction
    const leftH = canGoLeft ? horizontalIndices[currentHIndex - 1] : null;
    const rightH = canGoRight ? horizontalIndices[currentHIndex + 1] : null;
    const upSlide = canGoUp ? currentStack[currentVIndex - 1] : null;
    const downSlide = canGoDown ? currentStack[currentVIndex + 1] : null;

    // For left/right, go to v=0 of that stack (first slide in stack)
    const leftSlide = leftH !== null ? slides.find(s => s.h === leftH && s.v === 0) : null;
    const rightSlide = rightH !== null ? slides.find(s => s.h === rightH && s.v === 0) : null;

    return {
      canGoLeft,
      canGoRight,
      canGoUp,
      canGoDown,
      leftSlide,
      rightSlide,
      upSlide,
      downSlide,
      // Show stack info: how many slides in current horizontal stack
      stackSize: currentStack.length,
      stackPosition: currentVIndex + 1, // 1-indexed
    };
  }, [slides, currentSlide]);

  // Directional navigation functions
  const goLeft = useCallback(() => {
    if (navigation.leftSlide) {
      navigateTo(navigation.leftSlide.h, navigation.leftSlide.v);
    }
  }, [navigation.leftSlide, navigateTo]);

  const goRight = useCallback(() => {
    if (navigation.rightSlide) {
      navigateTo(navigation.rightSlide.h, navigation.rightSlide.v);
    }
  }, [navigation.rightSlide, navigateTo]);

  const goUp = useCallback(() => {
    if (navigation.upSlide) {
      navigateTo(navigation.upSlide.h, navigation.upSlide.v);
    }
  }, [navigation.upSlide, navigateTo]);

  const goDown = useCallback(() => {
    if (navigation.downSlide) {
      navigateTo(navigation.downSlide.h, navigation.downSlide.v);
    }
  }, [navigation.downSlide, navigateTo]);

  // Keyboard navigation - use actual directional keys
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goLeft();
      } else if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        goRight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        goUp();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        goDown();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goLeft, goRight, goUp, goDown]);

  // Render notes as markdown
  const renderedNotes = useMemo(() => {
    if (!currentSlideData?.notes) return null;
    return marked.parse(currentSlideData.notes);
  }, [currentSlideData?.notes]);

  // Build speaker URL for phone QR
  const speakerUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/${slideId}/speaker`
    : `/${slideId}/speaker`;

  return (
    <div className="fixed inset-0 bg-gray-900 text-white flex flex-col">
      {/* Phone control QR overlay - shown locally in speaker view */}
      {showPhoneQR && (
        <QRCodeOverlay
          url={speakerUrl}
          title="Scan to Control from Phone"
          onClose={() => setShowPhoneQR(false)}
        />
      )}

      {/* Header - Timers and Controls */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        {/* Left side: Elapsed timer with reset */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-lg font-mono">
            <IconClock size={20} className="text-gray-400" />
            <span>{formatTime(elapsedTime)}</span>
          </div>
          <button
            onClick={resetTimer}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Reset timer"
          >
            <IconRefresh size={16} />
          </button>
        </div>

        {/* Center: Countdown timer (if set) or "Set end time" button */}
        <div className="flex items-center gap-2">
          {showEndTimeInput ? (
            <div className="flex items-center gap-2">
              <input
                type="time"
                className="bg-gray-700 text-white px-2 py-1 rounded text-sm border border-gray-600 focus:border-blue-500 focus:outline-none"
                onBlur={(e) => e.target.value && handleSetEndTime(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.target.value && handleSetEndTime(e.target.value)}
                autoFocus
              />
              <button
                onClick={() => setShowEndTimeInput(false)}
                className="p-1 text-gray-400 hover:text-white"
                title="Cancel"
              >
                <IconX size={16} />
              </button>
            </div>
          ) : timeRemaining !== null ? (
            <div className="flex items-center gap-2">
              <span className={`text-lg font-mono ${timeRemaining <= 5 * 60 * 1000 ? 'text-red-400' : timeRemaining <= 15 * 60 * 1000 ? 'text-yellow-400' : 'text-green-400'}`}>
                <IconClockStop size={18} className="inline mr-1" />
                {formatTimeRemaining(timeRemaining)}
              </span>
              <button
                onClick={clearEndTime}
                className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                title="Clear end time"
              >
                <IconX size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowEndTimeInput(true)}
              className="flex items-center gap-1 px-2 py-1 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
              title="Set presentation end time"
            >
              <IconClockStop size={16} />
              <span className="hidden sm:inline">Set end time</span>
            </button>
          )}
        </div>

        {/* Right side: Share/Phone buttons, Viewer count, and connection status */}
        <div className="flex items-center gap-2">
          {/* Share QR button - toggles follow QR on presenter screen */}
          <button
            onClick={() => {
              if (remoteQRShowing) {
                socketRef.current?.emit('hideqr');
              } else {
                socketRef.current?.emit('showqr', { type: 'follow' });
              }
              setRemoteQRShowing(!remoteQRShowing);
            }}
            className={`p-2 rounded transition-colors ${
              remoteQRShowing
                ? 'text-blue-400 bg-blue-900/50 hover:bg-blue-900'
                : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
            title={remoteQRShowing ? 'Hide share QR on presentation' : 'Show share QR on presentation'}
          >
            <IconQrcode size={18} />
          </button>

          {/* Phone control button - shows speaker QR locally in speaker view */}
          <button
            onClick={() => setShowPhoneQR(true)}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Show phone control QR"
          >
            <IconDeviceMobile size={18} />
          </button>

          {/* Viewer count */}
          <div className="flex items-center gap-1.5 text-gray-400 text-sm ml-1">
            <IconUsers size={16} />
            <span>{viewerCount}</span>
          </div>

          {/* Connection status */}
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
        </div>
      </div>

      {/* Main Content - responsive layout:
          - Narrow (<768px): stacked vertically (slides, then notes), scrollable
          - Wide (md+): slides on left (stacked), notes on right side-by-side */}
      <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden">
        {/* Slide Previews Column - always stacked vertically */}
        <div ref={previewContainerRef} className="flex flex-col gap-4 p-4 bg-gray-800/50 md:w-1/2 md:overflow-y-auto">
          {/* Current Slide */}
          <div>
            <div className="text-xs text-gray-400 mb-2 uppercase tracking-wide">Current</div>
            <div
              className="bg-gray-900 rounded-lg overflow-hidden relative"
              style={{ paddingBottom: '56.25%' /* 16:9 aspect ratio */ }}
            >
              <iframe
                src={`/${slideId}/follow?preview=true#/${currentSlide.h}${currentSlide.v > 0 ? `/${currentSlide.v}` : ''}`}
                className="absolute top-0 left-0 border-0 pointer-events-none"
                title="Current slide"
                style={{
                  width: '960px',
                  height: '540px',
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          </div>

          {/* Next Slide */}
          <div>
            <div className="text-xs text-gray-400 mb-2 uppercase tracking-wide">Next</div>
            <div
              className="bg-gray-900 rounded-lg overflow-hidden relative"
              style={{ paddingBottom: '56.25%' /* 16:9 aspect ratio */ }}
            >
              {nextSlideData ? (
                <iframe
                  src={`/${slideId}/follow?preview=true#/${nextSlideData.h}${nextSlideData.v > 0 ? `/${nextSlideData.v}` : ''}`}
                  className="absolute top-0 left-0 border-0 pointer-events-none opacity-70"
                  title="Next slide"
                  style={{
                    width: '960px',
                    height: '540px',
                    transform: `scale(${previewScale})`,
                    transformOrigin: 'top left',
                  }}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                  End of presentation
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Speaker Notes Column - on right side on wide screens */}
        <div className="p-4 pb-8 md:w-1/2 md:overflow-y-auto md:border-l md:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-gray-400 uppercase tracking-wide">Notes</div>
            {/* Font zoom controls - only show on wide screens */}
            <div className="hidden md:flex items-center gap-1">
              <button
                onClick={zoomNotesOut}
                disabled={notesFontSize <= 0.5}
                className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title="Decrease font size"
              >
                <IconMinus size={14} />
              </button>
              <span className="text-xs text-gray-500 w-10 text-center">
                {Math.round(notesFontSize * 100)}%
              </span>
              <button
                onClick={zoomNotesIn}
                disabled={notesFontSize >= 2}
                className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title="Increase font size"
              >
                <IconPlus size={14} />
              </button>
            </div>
          </div>
          {renderedNotes ? (
            <div
              className="speaker-notes text-white"
              style={{ fontSize: `${notesFontSize}rem` }}
              dangerouslySetInnerHTML={{ __html: renderedNotes }}
            />
          ) : (
            <p className="text-gray-500 italic">No notes for this slide</p>
          )}
        </div>
        {/* Speaker notes styles - inline to avoid relying on prose plugin */}
        <style>{`
          .speaker-notes { word-wrap: break-word; overflow-wrap: break-word; white-space: normal; }
          .speaker-notes h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.75rem; }
          .speaker-notes h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
          .speaker-notes h3 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; }
          .speaker-notes p { margin-bottom: 0.5rem; }
          .speaker-notes ul, .speaker-notes ol { padding-left: 1.5rem; margin-bottom: 0.5rem; }
          .speaker-notes ul { list-style-type: disc; }
          .speaker-notes ol { list-style-type: decimal; }
          .speaker-notes li { margin-bottom: 0.25rem; }
          .speaker-notes strong { font-weight: 700; }
          .speaker-notes em { font-style: italic; }
          .speaker-notes code { background: rgba(255,255,255,0.1); padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: monospace; word-break: break-all; }
          .speaker-notes pre { background: rgba(255,255,255,0.1); padding: 0.75rem; border-radius: 0.375rem; overflow-x: auto; margin-bottom: 0.5rem; white-space: pre-wrap; word-wrap: break-word; }
          .speaker-notes blockquote { border-left: 3px solid rgba(255,255,255,0.3); padding-left: 1rem; font-style: italic; color: rgba(255,255,255,0.8); }
          .speaker-notes a { color: #60a5fa; text-decoration: underline; word-break: break-all; }
        `}</style>
      </div>

      {/* Footer - Navigation Controls */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-t border-gray-700">
        {/* Left side: Slide count */}
        <div className="flex flex-col items-start min-w-[100px]">
          <div className="text-2xl font-bold font-mono">
            {currentIndex + 1}<span className="text-gray-500">/</span>{slides.length}
          </div>
          <div className="text-xs text-gray-400">
            Slide {currentSlide.h + 1}{navigation.stackSize > 1 ? `.${currentSlide.v + 1}` : ''}
          </div>
        </div>

        {/* Center: Directional Navigation Controls */}
        <div className="flex items-center gap-1">
          {/* Left arrow */}
          <button
            onClick={goLeft}
            disabled={!navigation.canGoLeft}
            className="p-3 bg-gray-700 rounded-lg disabled:opacity-20 disabled:cursor-not-allowed hover:bg-gray-600 active:bg-gray-500 transition-colors"
            title="Previous section (←)"
          >
            <IconChevronLeft size={28} />
          </button>

          {/* Up/Down stack in the middle */}
          <div className="flex flex-col gap-1">
            <button
              onClick={goUp}
              disabled={!navigation.canGoUp}
              className="p-2 bg-gray-700 rounded-lg disabled:opacity-20 disabled:cursor-not-allowed hover:bg-gray-600 active:bg-gray-500 transition-colors"
              title="Previous in stack (↑)"
            >
              <IconChevronUp size={24} />
            </button>
            <button
              onClick={goDown}
              disabled={!navigation.canGoDown}
              className="p-2 bg-gray-700 rounded-lg disabled:opacity-20 disabled:cursor-not-allowed hover:bg-gray-600 active:bg-gray-500 transition-colors"
              title="Next in stack (↓)"
            >
              <IconChevronDown size={24} />
            </button>
          </div>

          {/* Right arrow */}
          <button
            onClick={goRight}
            disabled={!navigation.canGoRight}
            className="p-3 bg-blue-600 rounded-lg disabled:opacity-20 disabled:cursor-not-allowed hover:bg-blue-500 active:bg-blue-400 transition-colors"
            title="Next section (→)"
          >
            <IconChevronRight size={28} />
          </button>
        </div>

        {/* Right side: Stack indicator (if in a vertical stack) */}
        <div className="flex flex-col items-end min-w-[100px]">
          {navigation.stackSize > 1 && (
            <>
              <div className="text-sm font-medium text-gray-300">
                Stack {navigation.stackPosition}/{navigation.stackSize}
              </div>
              <div className="text-xs text-gray-500">
                Use ↑↓ to navigate
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
