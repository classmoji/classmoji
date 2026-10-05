import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type * as Y from 'yjs';

import { historyKey } from '~/utils/collab/bridgeLogic';
import { applyNotesEdit, transformIndex, type TextDelta } from '~/utils/collab/textCursor';

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
  /** The id of a slide just added (it gets one on demand), or null. */
  ensureId?(slide: HTMLElement): string | null;
  /** Undo / redo this person's own notes edits on a slide. */
  history?(slideId: string, kind: 'undo' | 'redo'): boolean;
}

interface SlideNotesPanelProps {
  revealInstance: RevealApi | null;
  isCollapsed: boolean;
  onToggle: () => void;
  onContentChange?: () => void;
  readOnly?: boolean;
  collabNotes?: CollabNotesBinding | null;
}

/** Where a change ends in the new text (the caret after an undo / redo). */
function deltaEnd(delta: TextDelta): number {
  let pos = 0;
  let end = 0;
  for (const op of delta) {
    if (op.retain !== undefined) pos += op.retain;
    else if (op.insert !== undefined) {
      pos += typeof op.insert === 'string' ? op.insert.length : 1;
      end = pos;
    } else if (op.delete !== undefined) end = pos;
  }
  return end;
}

/**
 * A Y.Text as a controlled textarea value that keeps the caret through remote
 * edits. `rendered` is what the textarea last showed and `remoteSince` the
 * remote changes that landed after it: a keystroke is the difference from
 * what was SHOWN, moved past those changes — never a diff against text the
 * person did not see (which would delete it).
 */
function useYTextValue(
  text: Y.Text | null,
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  origin: unknown
) {
  const [value, setValue] = useState(() => text?.toString() ?? '');
  const pendingSelection = useRef<[number, number] | null>(null);
  const rendered = useRef(value);
  const remoteSince = useRef<TextDelta[]>([]);

  useEffect(() => {
    const initial = text?.toString() ?? '';
    setValue(initial);
    rendered.current = initial;
    remoteSince.current = [];
    if (!text) return;
    const onChange = (event: Y.YTextEvent) => {
      const delta = event.delta as TextDelta;
      const el = textarea.current;
      if (!event.transaction.local) {
        remoteSince.current.push(delta);
        if (el && document.activeElement === el) {
          pendingSelection.current = [
            transformIndex(el.selectionStart, delta),
            transformIndex(el.selectionEnd, delta),
          ];
        }
      } else if (event.transaction.origin !== origin && el) {
        // Undo / redo: the caret goes where the change is.
        const at = deltaEnd(delta);
        pendingSelection.current = [at, at];
      }
      setValue(text.toString());
    };
    text.observe(onChange);
    return () => text.unobserve(onChange);
  }, [text, textarea, origin]);

  useLayoutEffect(() => {
    rendered.current = value;
    remoteSince.current = [];
    const selection = pendingSelection.current;
    const el = textarea.current;
    if (selection && el) {
      el.setSelectionRange(selection[0], selection[1]);
      pendingSelection.current = null;
    }
  }, [value, textarea]);

  return { value, rendered, remoteSince };
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
  // A slide just added has no id until the editor writes it (debounced):
  // re-read it once the id is stamped.
  const [idSeq, setIdSeq] = useState(0);
  const currentSlideId = currentSlide?.getAttribute('data-cm-id') ?? null;
  const collabText = collabNotes ? collabNotes.textFor(currentSlideId) : null;
  const live = useYTextValue(collabText, textareaRef, collabNotes?.origin);
  // Notes typed before the slide had its id: kept here, written once it has one.
  const [buffered, setBuffered] = useState<{ slide: HTMLElement; value: string } | null>(null);
  const bufferedHere = buffered && buffered.slide === currentSlide ? buffered.value : null;
  const notes = collabNotes ? (bufferedHere ?? live.value) : domNotes;
  void idSeq;

  useEffect(() => {
    if (!buffered || !collabNotes) return;
    const apply = () => {
      const id = buffered.slide.getAttribute('data-cm-id');
      const text = collabNotes.textFor(id);
      if (!text || !id) return false;
      const write = () => applyNotesEdit(text, text.toString(), buffered.value, []);
      if (text.doc) text.doc.transact(write, collabNotes.origin);
      else write();
      setBuffered(null);
      setIdSeq(n => n + 1);
      return true;
    };
    if (apply()) return;
    const timer = setInterval(() => {
      if (!buffered.slide.isConnected) {
        setBuffered(null);
        return;
      }
      collabNotes.ensureId?.(buffered.slide);
      if (apply()) clearInterval(timer);
    }, 300);
    return () => clearInterval(timer);
  }, [buffered, collabNotes]);

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
        let text = collabText;
        let slideId = currentSlideId;
        if ((!text || !slideId) && currentSlide && !bufferedHere) {
          // A slide just added: give it its id now.
          slideId = collabNotes.ensureId?.(currentSlide) ?? null;
          text = collabNotes.textFor(slideId);
          if (text) setIdSeq(n => n + 1);
        }
        if (!text || !slideId || bufferedHere !== null) {
          if (currentSlide) setBuffered({ slide: currentSlide, value: newNotes });
          return;
        }
        const target = text;
        const shown = text === collabText ? live.rendered.current : text.toString();
        const remote = text === collabText ? live.remoteSince.current : [];
        const apply = () => applyNotesEdit(target, shown, newNotes, remote);
        if (target.doc) target.doc.transact(apply, collabNotes.origin);
        else apply();
        if (newNotes === '') collabNotes.onEmptied(slideId);
        return;
      }
      setNotes(newNotes);
      updateNotesInSlide(currentSlide, newNotes);
      onContentChange?.();
    },
    [currentSlide, onContentChange, collabNotes, collabText, currentSlideId, bufferedHere, live]
  );

  // Live notes: ⌘Z / ⇧⌘Z undo this person's own notes edits (the textarea's
  // native undo would replay stale values over other people's typing).
  const handleNotesKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!collabNotes?.history || !currentSlideId) return;
      const kind = historyKey(e);
      if (!kind) return;
      e.preventDefault();
      collabNotes.history(currentSlideId, kind);
    },
    [collabNotes, currentSlideId]
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
              onKeyDown={collabNotes ? handleNotesKeyDown : undefined}
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
