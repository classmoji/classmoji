import { useCallback } from 'react';
import { IconTrash } from '@tabler/icons-react';
import { useElementSelection } from './ElementSelectionContext';
import { elementPropertyEditors } from './editors';

/**
 * PropertiesPanel - The sidebar that displays property editors for selected elements
 *
 * Uses a registry pattern to dynamically render the appropriate property editor
 * based on the type of element currently selected.
 */
export default function PropertiesPanel() {
  const { selectedElement, elementType, selectElement, clearSelection, onContentChange } = useElementSelection();

  // Select the current slide section for slide-level properties
  const handleSelectSlide = useCallback((event) => {
    // Prevent the button click from bubbling to document handlers
    event?.stopPropagation();
    event?.preventDefault();

    // Try multiple selectors to find the current slide
    // 1. First try .present class (Reveal.js marks current slide)
    let currentSlide = document.querySelector('.reveal .slides section.present:not(.stack)');

    // 2. If no .present, try finding the first visible section
    if (!currentSlide) {
      currentSlide = document.querySelector('.reveal .slides > section');
    }

    // 3. For vertical slides, check for nested present section
    if (currentSlide) {
      const nestedPresent = currentSlide.querySelector('section.present');
      if (nestedPresent) {
        currentSlide = nestedPresent;
      }
    }

    // Use setTimeout to ensure this runs after the current event loop completes
    // This prevents any interference from the button click event handling
    if (currentSlide) {
      setTimeout(() => {
        currentSlide.click();
      }, 0);
    }
  }, []);

  // Check if slide is already selected
  const isSlideSelected = elementType === 'slide';

  // Delete the selected element
  const handleDelete = useCallback(() => {
    if (!selectedElement) return;

    // Remove the element from DOM
    selectedElement.remove();

    // Clear selection
    clearSelection();

    // Notify of content change (triggers save)
    onContentChange?.();
  }, [selectedElement, clearSelection, onContentChange]);

  // Determine if the current element type is deletable
  // Don't allow deleting slides or columns (too destructive)
  const isDeletable = elementType && !['slide', 'column'].includes(elementType);

  return (
    <div
      data-properties-panel
      className="w-64 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 h-full overflow-y-auto"
    >
      <div className="p-4">
        {/* Header */}
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
          Properties
        </h2>

        {/* Quick access: Slide Settings button */}
        {!isSlideSelected && (
          <button
            onClick={handleSelectSlide}
            className="w-full mb-4 px-3 py-2 text-sm text-left bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 rounded-lg border border-gray-200 dark:border-gray-600 transition-colors"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
              </svg>
              <span className="text-gray-700 dark:text-gray-200">Slide Layout & Settings</span>
            </div>
          </button>
        )}

        {/* Content based on selection */}
        {!elementType ? (
          <EmptyState />
        ) : (
          <>
            <PropertyEditor type={elementType} element={selectedElement} />

            {/* Delete button - shown for deletable element types */}
            {isDeletable && (
              <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={handleDelete}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-lg transition-colors"
                >
                  <IconTrash size={16} />
                  Delete Element
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * PropertyEditor - Renders the appropriate editor for the element type
 */
function PropertyEditor({ type, element }) {
  const Editor = elementPropertyEditors[type];

  if (!Editor) {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400">
        No properties available for this element type.
      </div>
    );
  }

  return <Editor element={element} />;
}

/**
 * EmptyState - Shown when no element is selected
 */
function EmptyState() {
  return (
    <div className="text-center py-8">
      <div className="text-gray-400 dark:text-gray-500 mb-2">
        <svg
          className="w-12 h-12 mx-auto"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"
          />
        </svg>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Click an element to edit its properties
      </p>
    </div>
  );
}
