import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type * as Y from 'yjs';
import { setYText } from '@classmoji/collab';

import { transformIndex, type TextDelta } from '~/utils/collab/textCursor';

/**
 * SlideNotesPanel - Collapsible panel for editing speaker notes
 *
 * Displays below the slide preview when editing. Notes are stored as
 * <aside class="notes"> inside each <section> element, which is the
 * standard Reveal.js format for speaker notes.
 *
 * Notes automatically sync when navigating between slides via Reveal.js events.
 */

// Extract notes from the current slide section
function extractNotesFromSlide(slideElement: HTMLElement | null) {
  if (!slideElement) return '';
  // Use :scope to only get direct child <aside class="notes">
  // This handles nested sections (vertical slides) correctly
  const aside = slideElement.querySelector(':scope > aside.notes');
  return aside ? aside.innerHTML : '';
}

// Update or create notes in the slide section
function updateNotesInSlide(slideElement: HTMLElement | null, notesContent: string) {
  if (!slideElement) return;

  let aside = slideElement.querySelector(':scope > aside.notes');

  // If notes are empty, remove the aside element entirely
  if (!notesContent || notesContent.trim() === '') {
    if (aside) {
      aside.remove();
    }
    return;
  }

  // Create aside if it doesn't exist
  if (!aside) {
    aside = document.createElement('aside');
    aside.className = 'notes';
    slideElement.appendChild(aside);
  }

  // Only update if content changed (prevents unnecessary DOM mutations)
  if (aside.innerHTML !== notesContent) {
    aside.innerHTML = notesContent;
  }
}

/**
 * Live editing: notes live in the deck document as a Y.Text per slide, edited
 * character by character (no slide lock), instead of the slide's aside.
 */
export interface CollabNotesBinding {
  textFor(slideId: string | null): Y.Text | null;
  /** The notes were emptied: the slide has no notes any more. */
  onEmptied(slideId: string): void;
  /** Transaction origin for local notes edits. */
  origin: unknown;
}

interface SlideNotesPanelProps {
  revealInstance: RevealApi | null;
  isCollapsed: boolean;
  onToggle: () => void;
  onContentChange?: () => void;
  readOnly?: boolean;
  collabNotes?: CollabNotesBinding | null;
}

/** A Y.Text as a controlled textarea value that keeps the caret through remote edits. */
function useYTextValue(text: Y.Text | null, textarea: React.RefObject<HTMLTextAreaElement | null>) {
  const [value, setValue] = useState(() => text?.toString() ?? '');
  const pendingSelection = useRef<[number, number] | null>(null);

  useEffect(() => {
    setValue(text?.toString() ?? '');
    if (!text) return;
    const onChange = (event: Y.YTextEvent) => {
      if (!event.transaction.local) {
        const el = textarea.current;
        if (el && document.activeElement === el) {
          const delta = event.delta as TextDelta;
          pendingSelection.current = [
            transformIndex(el.selectionStart, delta),
            transformIndex(el.selectionEnd, delta),
          ];
        }
      }
      setValue(text.toString());
    };
    text.observe(onChange);
    return () => text.unobserve(onChange);
  }, [text, textarea]);

  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const el = textarea.current;
    if (selection && el) {
      el.setSelectionRange(selection[0], selection[1]);
      pendingSelection.current = null;
    }
  }, [value, textarea]);

  return value;
}

export default function SlideNotesPanel({
  revealInstance, // Pass the Reveal.js instance directly (not a ref)
  isCollapsed,
  onToggle,
  onContentChange,
  readOnly = false, // In read-only mode, only show markdown preview (no editing)
  collabNotes = null,
}: SlideNotesPanelProps) {
  const [domNotes, setNotes] = useState('');
  const [currentSlide, setCurrentSlide] = useState<HTMLElement | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const currentSlideId = currentSlide?.getAttribute('data-cm-id') ?? null;
  const collabText = collabNotes ? collabNotes.textFor(currentSlideId) : null;
  const liveNotes = useYTextValue(collabText, textareaRef);
  const notes = collabNotes ? liveNotes : domNotes;

  // Track the current slide via Reveal.js events
  // Using revealInstance (state) instead of a ref ensures this effect re-runs
  // when Reveal.js finishes initializing
  useEffect(() => {
    if (!revealInstance) return;

    const handleSlideChange = () => {
      const indices = revealInstance.getIndices();
      const slide = revealInstance.getSlide(indices.h, indices.v);
      setCurrentSlide(slide);
      setNotes(extractNotesFromSlide(slide));
    };

    // Listen for slide changes
    revealInstance.on('slidechanged', handleSlideChange);

    // Initial load - get current slide
    handleSlideChange();

    return () => {
      revealInstance.off('slidechanged', handleSlideChange);
    };
  }, [revealInstance]);

  // Handle notes textarea changes
  const handleNotesChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newNotes = e.target.value;
      if (collabNotes) {
        if (!collabText || !currentSlideId) return;
        const doc = collabText.doc;
        const apply = () => setYText(collabText, newNotes);
        if (doc) doc.transact(apply, collabNotes.origin);
        else apply();
        if (newNotes === '') collabNotes.onEmptied(currentSlideId);
        return;
      }
      setNotes(newNotes);
      updateNotesInSlide(currentSlide, newNotes);
      onContentChange?.();
    },
    [currentSlide, onContentChange, collabNotes, collabText, currentSlideId]
  );

  return (
    <div className={`slide-notes-panel ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Header - always visible, click to toggle */}
      <div className="slide-notes-panel-header" onClick={onToggle}>
        <h3>
          <svg
            className={`toggle-icon ${isCollapsed ? '' : 'expanded'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
          Speaker Notes
        </h3>
        {isCollapsed && notes && (
          <span className="text-xs text-gray-400 italic truncate max-w-xs">
            {notes.replace(/<[^>]*>/g, '').slice(0, 50)}
            {notes.length > 50 ? '...' : ''}
          </span>
        )}
      </div>

      {/* Content - hidden when collapsed */}
      {!isCollapsed && (
        <div className="slide-notes-panel-content">
          {/* Edit/Preview toggle - only show in edit mode */}
          {!readOnly && (
            <div className="notes-mode-toggle">
              <button
                className={`toggle-btn ${!isEditMode ? 'active' : ''}`}
                onClick={() => setIsEditMode(false)}
              >
                Preview
              </button>
              <button
                className={`toggle-btn ${isEditMode ? 'active' : ''}`}
                onClick={() => setIsEditMode(true)}
              >
                Edit
              </button>
            </div>
          )}

          {!readOnly && isEditMode ? (
            <textarea
              ref={textareaRef}
              value={notes}
              onChange={handleNotesChange}
              placeholder="Add speaker notes for this slide...&#10;&#10;Supports markdown:&#10;* Bullet points&#10;**bold** and _italic_&#10;`code`"
            />
          ) : (
            <div
              className={`notes-preview ${readOnly ? 'read-only' : ''}`}
              onClick={readOnly ? undefined : () => setIsEditMode(true)}
              title={readOnly ? undefined : 'Click to edit'}
            >
              {notes ? (
                <ReactMarkdown>{notes}</ReactMarkdown>
              ) : (
                <p className="placeholder">
                  {readOnly ? 'No speaker notes for this slide' : 'Click to add speaker notes...'}
                </p>
              )}
            </div>
          )}

          <p className="hint">
            Press{' '}
            <kbd className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded-sm text-xs">S</kbd>{' '}
            during presentation to view notes
          </p>
        </div>
      )}
    </div>
  );
}
