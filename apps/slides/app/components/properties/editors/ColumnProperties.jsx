import { useCallback } from 'react';
import PropertySection from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';

/**
 * ColumnProperties - Property editor for column divs in grid layouts
 *
 * Provides quick actions for adding content to a column.
 */
export default function ColumnProperties({ element }) {
  const { onContentChange } = useElementSelection();

  // Add a paragraph to the column
  const handleAddParagraph = useCallback(() => {
    if (!element) return;
    const p = document.createElement('p');
    p.textContent = 'New paragraph...';
    element.appendChild(p);
    onContentChange?.();
  }, [element, onContentChange]);

  // Add a heading to the column
  const handleAddHeading = useCallback((level) => {
    if (!element) return;
    const h = document.createElement(`h${level}`);
    h.textContent = `Heading ${level}`;
    element.appendChild(h);
    onContentChange?.();
  }, [element, onContentChange]);

  // Add a bullet list to the column
  const handleAddList = useCallback(() => {
    if (!element) return;
    const ul = document.createElement('ul');
    ul.innerHTML = '<li>List item</li>';
    element.appendChild(ul);
    onContentChange?.();
  }, [element, onContentChange]);

  if (!element) {
    return null;
  }

  // Count children in the column
  const childCount = element.children.length;

  return (
    <div className="space-y-4">
      <PropertySection title="Column">
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This column has <strong>{childCount}</strong> element{childCount !== 1 ? 's' : ''}.
          </p>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Click directly on content inside to edit it, or add new elements below:
          </p>

          {/* Add content buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleAddParagraph}
              className="px-2 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors"
            >
              + Paragraph
            </button>
            <button
              onClick={() => handleAddHeading(2)}
              className="px-2 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors"
            >
              + Heading
            </button>
            <button
              onClick={handleAddList}
              className="px-2 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm transition-colors"
            >
              + List
            </button>
          </div>
        </div>
      </PropertySection>

      <PropertySection title="Tips">
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-2">
          <p>
            You can also type directly in the column - just click inside and start typing.
          </p>
          <p>
            Use the toolbar buttons to format text or add code blocks.
          </p>
        </div>
      </PropertySection>
    </div>
  );
}
