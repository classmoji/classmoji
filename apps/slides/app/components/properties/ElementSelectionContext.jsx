import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { reHighlightCode } from './utils/codeBlockUtils';

/**
 * ElementSelectionContext - Tracks the currently selected element in the slide editor
 *
 * The context detects clicks within the editor and determines what type of element
 * was clicked (code block, text, image, etc.) to show the appropriate properties panel.
 *
 * Also tracks the "active column" - which column DIV should receive new content
 * when using toolbar buttons in a multi-column layout.
 *
 * When selection changes FROM a code block TO something else, we automatically
 * re-apply syntax highlighting to the code block.
 */

const ElementSelectionContext = createContext(null);

/**
 * Find the column DIV that contains an element (if any)
 * Returns the column DIV or null if not in a column
 */
function findContainingColumn(element) {
  let current = element;
  while (current) {
    // Check if this is a column div (direct child of section with layout class)
    if (current.tagName === 'DIV' && current.parentElement?.tagName === 'SECTION') {
      const section = current.parentElement;
      if (section.className?.includes('slide-layout-')) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Update the visual active state on column divs
 *
 * When setting a new active column: clears only current slide's columns (prevents stale state)
 * When clearing (null): clears ALL columns globally (for clean exit from edit mode)
 */
function updateColumnActiveState(activeColumn) {
  if (activeColumn) {
    // Setting a new active column - scope cleanup to current slide only
    // This prevents stale data-column-active attributes on other slides
    const currentSlide = document.querySelector('section.stack.present section.present[contenteditable="true"]')
      || document.querySelector('section.present[contenteditable="true"]:not(.stack)');

    if (currentSlide) {
      currentSlide.querySelectorAll('[data-column-active]').forEach(col => {
        col.removeAttribute('data-column-active');
      });
    }
    activeColumn.setAttribute('data-column-active', 'true');
  } else {
    // Clearing all active states (e.g., exiting edit mode) - do global cleanup
    document.querySelectorAll('[data-column-active]').forEach(col => {
      col.removeAttribute('data-column-active');
    });
  }
}

/**
 * Detect the element type by walking up the DOM tree
 * Returns { type, element } or { type: null, element: null }
 */
function detectElementType(element, editorContainer) {
  let current = element;
  let sectionElement = null;

  // FIRST PASS: Check if we're inside an sl-block or sandpack-embed
  // These should be selected as a whole, not their inner content
  let checkEl = element;
  while (checkEl && checkEl !== editorContainer && checkEl !== document.body) {
    if (checkEl.classList?.contains('sl-block')) {
      // Check block type for specialized handling
      const blockType = checkEl.dataset?.blockType;
      if (blockType === 'sandpack') {
        // Return the sandpack-embed element inside for properties editing
        const sandpackEmbed = checkEl.querySelector('.sandpack-embed');
        return { type: 'sandpack', element: sandpackEmbed || checkEl, blockElement: checkEl };
      }
      return { type: 'block', element: checkEl };
    }
    checkEl = checkEl.parentElement;
  }

  // SECOND PASS: Normal element type detection (for non-block elements)
  while (current && current !== editorContainer && current !== document.body) {
    // Code blocks: <pre> containing <code>
    if (current.tagName === 'PRE' && current.querySelector('code')) {
      return { type: 'code', element: current };
    }

    // Images
    if (current.tagName === 'IMG') {
      return { type: 'image', element: current };
    }

    // Iframes (direct or inside wrapper)
    if (current.tagName === 'IFRAME') {
      return { type: 'iframe', element: current };
    }

    // Iframe wrapper - select the iframe inside
    if (current.classList?.contains('iframe-wrapper')) {
      const iframe = current.querySelector('iframe');
      if (iframe) {
        return { type: 'iframe', element: iframe };
      }
    }

    // Text elements: headings, paragraphs, list items
    if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI'].includes(current.tagName)) {
      return { type: 'text', element: current };
    }

    // Column divs: direct children of section used for grid layouts
    // Only detect divs that are direct children of a section (not nested divs)
    if (current.tagName === 'DIV' && current.parentElement?.tagName === 'SECTION') {
      return { type: 'column', element: current };
    }

    // Track if we're inside a section (slide)
    // Skip stack sections - they're containers for vertical slides, not content slides
    if (current.tagName === 'SECTION' && !current.classList.contains('stack')) {
      sectionElement = current;
    }

    current = current.parentElement;
  }

  // If no specific element was found but we clicked inside a slide section,
  // return the section for slide-level properties
  if (sectionElement) {
    return { type: 'slide', element: sectionElement };
  }

  return { type: null, element: null };
}

export function ElementSelectionProvider({ children, editorRef, isEditing, onContentChange, onSaveContent, snippets = [], onSaveSnippet, onUpdateSnippet, onDeleteSnippet, cssThemes = [], onSaveTheme, onUpdateTheme, onDeleteTheme, customThemes = [], sharedThemes = [] }) {
  const [selectedElement, setSelectedElement] = useState(null);
  const [elementType, setElementType] = useState(null);
  const [blockElement, setBlockElement] = useState(null); // For sl-block wrapper when element is inside a block
  const [activeColumn, setActiveColumn] = useState(null);
  const previousSelectionRef = useRef({ element: null, type: null });

  // Re-highlight code block when selection changes away from it
  const handleSelectionChange = useCallback((newElement, newType, newBlockElement = null) => {
    const prev = previousSelectionRef.current;

    // Skip if selecting the same element - prevents unnecessary re-renders
    // which can cause flickering and cursor issues in code blocks
    if (prev.element === newElement && prev.type === newType) {
      return;
    }

    // If we're leaving a code block, re-highlight it
    if (prev.type === 'code' && prev.element && prev.element !== newElement) {
      const codeEl = prev.element.querySelector('code');
      if (codeEl) {
        reHighlightCode(codeEl);
      }
    }

    // Update state
    setSelectedElement(newElement);
    setElementType(newType);
    setBlockElement(newBlockElement);

    // Store for next comparison
    previousSelectionRef.current = { element: newElement, type: newType };
  }, []);

  // Handle clicks within the editor to detect element selection
  const handleEditorClick = useCallback((event) => {
    if (!isEditing) return;

    // Ignore clicks on the properties panel itself
    if (event.target.closest('[data-properties-panel]')) return;

    // Find the slides container as the boundary
    const slidesContainer = document.querySelector('.reveal .slides');
    const { type, element, blockElement: detectedBlockElement } = detectElementType(event.target, slidesContainer);

    // Also detect if click is inside a column (for active column tracking)
    const clickedColumn = findContainingColumn(event.target);
    if (clickedColumn !== activeColumn) {
      setActiveColumn(clickedColumn);
      updateColumnActiveState(clickedColumn);
    }

    handleSelectionChange(element, type, detectedBlockElement);
  }, [isEditing, handleSelectionChange, activeColumn]);

  // Clear selection when exiting edit mode
  useEffect(() => {
    if (!isEditing) {
      setSelectedElement(null);
      setElementType(null);
      setBlockElement(null);
      setActiveColumn(null);
      updateColumnActiveState(null);
    }
  }, [isEditing]);

  // Handle keyboard shortcuts in edit mode:
  // - Delete/Backspace: Remove selected element
  // - Escape: Clear selection
  // - Arrow keys: Navigate slides when nothing is selected
  const handleKeyDown = useCallback((event) => {
    if (!isEditing) return;

    // ==========================================
    // DELETE/BACKSPACE - Remove selected element
    // ==========================================
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedElement) {
      const activeEl = /** @type {HTMLElement | null} */ (document.activeElement);

      // Don't delete if focus is in an INPUT or TEXTAREA (form fields)
      if (activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA') {
        return;
      }

      // For text elements (H1, P, LI, etc.), let the browser handle Delete normally
      // so users can edit text content
      if (elementType === 'text') return;

      // If focus is inside the selected element, user is editing - don't delete the element
      // This handles: clicking on title to edit, double-clicking blocks to edit content, etc.
      if (selectedElement.contains(activeEl)) {
        return;
      }

      // ALSO: If activeEl is a contentEditable that contains the selected element,
      // and the caret is inside the selected element, don't delete.
      // In contentEditable, clicking on text makes the contentEditable root the activeElement,
      // but the caret may be inside our selected element.
      if (activeEl?.isContentEditable && activeEl.contains(selectedElement)) {
        // Check if the browser's text selection/caret is inside the selected element
        const selection = window.getSelection();
        if (selection && selection.anchorNode) {
          // anchorNode is the text node or element where the caret is
          if (selectedElement.contains(selection.anchorNode)) {
            return;
          }
        }
      }

      // Don't delete the slide itself or columns (too destructive)
      if (elementType === 'slide' || elementType === 'column') return;

      // Prevent the browser from deleting text elsewhere
      event.preventDefault();
      event.stopPropagation();

      // Remove the element from DOM
      selectedElement.remove();

      // Clear selection
      handleSelectionChange(null, null);

      // Notify of content change (triggers save)
      onContentChange?.();
      return;
    }

    // ==========================================
    // ESCAPE - Clear selection
    // ==========================================
    if (event.key === 'Escape' && selectedElement) {
      handleSelectionChange(null, null);
      return;
    }

    // ==========================================
    // ARROW KEYS - Navigate slides
    // ==========================================
    // Only handle arrow keys from here
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;

    // Don't navigate if an element is selected (user might be editing text)
    // Allow navigation only when nothing is selected (properties panel is empty)
    if (selectedElement) return;

    // Don't intercept if focus is in an input, textarea, or contenteditable
    const activeEl = /** @type {HTMLElement | null} */ (document.activeElement);
    if (activeEl) {
      const tagName = activeEl.tagName;
      if (tagName === 'INPUT' || tagName === 'TEXTAREA') return;
      if (activeEl.isContentEditable) return;
    }

    // Get the Reveal instance and navigate
    const revealInstance = editorRef?.current?.getRevealInstance?.();
    if (!revealInstance) return;

    event.preventDefault();

    switch (event.key) {
      case 'ArrowLeft':
        revealInstance.left();
        break;
      case 'ArrowRight':
        revealInstance.right();
        break;
      case 'ArrowUp':
        revealInstance.up();
        break;
      case 'ArrowDown':
        revealInstance.down();
        break;
    }
  }, [isEditing, selectedElement, elementType, handleSelectionChange, onContentChange, editorRef]);

  // Handle clicks outside the slides area to clear selection
  const handleDocumentClick = useCallback((event) => {
    if (!isEditing) return;

    // Ignore clicks on the properties panel
    if (event.target.closest('[data-properties-panel]')) return;

    // Ignore clicks on the toolbar/navbar
    if (event.target.closest('nav')) return;

    // Ignore clicks on Ant Design dropdowns/popups (rendered in portals at body level)
    if (event.target.closest('.ant-select-dropdown')) return;
    if (event.target.closest('.ant-dropdown')) return;
    if (event.target.closest('.ant-popover')) return;
    if (event.target.closest('.ant-modal')) return;

    // Ignore clicks on block resize overlay (trash button, resize handles, etc.)
    if (event.target.closest('.block-resize-overlay')) return;
    if (event.target.closest('.image-resize-overlay')) return;

    // Check if click is inside the slides area
    const slidesContainer = document.querySelector('.reveal .slides');
    if (slidesContainer && slidesContainer.contains(event.target)) {
      // Click is inside slides - let handleEditorClick handle it
      return;
    }

    // Click is outside slides area - clear selection
    handleSelectionChange(null, null);
  }, [isEditing, handleSelectionChange]);

  // Set up click listener on the editor
  // Note: editorRef is a component ref, so we query for the actual reveal container
  // We use a small delay to ensure Reveal.js has mounted
  useEffect(() => {
    if (!isEditing) return;

    let editorContainer = null;
    let timeoutId = null;
    let handleInput = null;

    const setupListener = () => {
      // Find the reveal slides container in the DOM
      editorContainer = document.querySelector('.reveal .slides');
      if (!editorContainer) {
        // Retry after a short delay if not found yet
        timeoutId = setTimeout(setupListener, 100);
        return;
      }

      editorContainer.addEventListener('click', handleEditorClick);

      // Listen for input events (typing) to trigger layout recalculation
      handleInput = () => {
        onContentChange?.(); // Triggers Reveal.js layout recalculation
      };
      editorContainer.addEventListener('input', handleInput);

      // Also listen on document for clicks outside the slides area
      document.addEventListener('click', handleDocumentClick);

      // Listen for keyboard navigation (arrow keys when nothing selected)
      document.addEventListener('keydown', handleKeyDown);
    };

    // Start looking for the container
    setupListener();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (editorContainer) {
        editorContainer.removeEventListener('click', handleEditorClick);
        if (handleInput) {
          editorContainer.removeEventListener('input', handleInput);
        }
      }
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isEditing, handleEditorClick, handleDocumentClick, handleKeyDown, onContentChange]);

  const clearSelection = useCallback(() => {
    // Re-highlight if we're clearing from a code block
    handleSelectionChange(null, null);
  }, [handleSelectionChange]);

  const selectElement = useCallback((element) => {
    // Use the actual DOM container for boundary detection
    const slidesContainer = document.querySelector('.reveal .slides');
    const { type, blockElement: detectedBlockElement } = detectElementType(element, slidesContainer);
    // Use handleSelectionChange to properly update all state including previousSelectionRef
    handleSelectionChange(element, type, detectedBlockElement);
  }, [handleSelectionChange]);

  // Set active column programmatically (e.g., when adding content to a specific column)
  const setActiveColumnElement = useCallback((column) => {
    setActiveColumn(column);
    updateColumnActiveState(column);
  }, []);

  // Get and set themes via editor ref
  // These are presentation-level settings stored on the .reveal container
  // Simplified to single theme (no light/dark mode split)
  const getThemes = useCallback(() => {
    const themes = editorRef?.current?.getThemes?.();
    return {
      theme: themes?.theme || 'white',
      codeTheme: themes?.codeTheme || 'github',
    };
  }, [editorRef]);

  const setTheme = useCallback((type, value) => {
    editorRef?.current?.setThemes?.({ [type]: value });
  }, [editorRef]);

  const value = {
    selectedElement,
    elementType,
    blockElement, // For sl-block wrapper when element is inside a block (e.g., sandpack)
    activeColumn,
    setActiveColumn: setActiveColumnElement,
    selectElement,
    clearSelection,
    onContentChange,
    onSaveContent, // Auto-save without exiting edit mode (used after destructive ops like Cloudinary upload)
    // Theme management (presentation-level settings)
    getThemes,
    setTheme,
    // Snippets
    snippets,
    onSaveSnippet,
    onUpdateSnippet,
    onDeleteSnippet,
    // CSS Themes (for editing)
    cssThemes,
    onSaveTheme,
    onUpdateTheme,
    onDeleteTheme,
    // Custom themes (for theme picker - includes cssUrl)
    customThemes,
    // Shared themes (folder-based themes from slides.com imports)
    sharedThemes,
  };

  return (
    <ElementSelectionContext.Provider value={value}>
      {children}
    </ElementSelectionContext.Provider>
  );
}

export function useElementSelection() {
  const context = useContext(ElementSelectionContext);
  if (!context) {
    throw new Error('useElementSelection must be used within ElementSelectionProvider');
  }
  return context;
}

export default ElementSelectionContext;
