import { useState, useCallback, useEffect } from 'react';
import { Select } from 'antd';
import PropertySection, { PropertyRow, PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import { convertToBlock, canConvertToBlock } from '../utils/convertToBlock';

/**
 * TextProperties - Property editor for text elements (headings, paragraphs, list items)
 *
 * Allows configuring:
 * - Element type (h1, h2, p, etc.)
 * - Text alignment
 * - Text color
 * - Font size
 */

// Element types that can be converted between
const ELEMENT_TYPES = [
  { value: 'H1', label: 'Heading 1' },
  { value: 'H2', label: 'Heading 2' },
  { value: 'H3', label: 'Heading 3' },
  { value: 'P', label: 'Paragraph' },
  { value: 'CODE', label: 'Code Block' },
];

const ALIGNMENTS = [
  { value: 'left', label: 'Left', icon: '⬅' },
  { value: 'center', label: 'Center', icon: '↔' },
  { value: 'right', label: 'Right', icon: '➡' },
  { value: 'justify', label: 'Justify', icon: '☰' },
];

const COLORS = [
  { value: 'inherit', label: 'Default' },
  { value: '#ffffff', label: 'White' },
  { value: '#000000', label: 'Black' },
  { value: '#ef4444', label: 'Red' },
  { value: '#f97316', label: 'Orange' },
  { value: '#eab308', label: 'Yellow' },
  { value: '#22c55e', label: 'Green' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#ec4899', label: 'Pink' },
];

const FONT_SIZES = [
  { value: '', label: 'Default' },
  { value: '0.75em', label: 'Extra Small' },
  { value: '0.875em', label: 'Small' },
  { value: '1em', label: 'Normal' },
  { value: '1.25em', label: 'Large' },
  { value: '1.5em', label: 'Extra Large' },
  { value: '2em', label: '2x' },
  { value: '3em', label: '3x' },
];

// Column options for lists
const COLUMN_OPTIONS = [
  { value: '1', label: '1 Column' },
  { value: '2', label: '2 Columns' },
  { value: '3', label: '3 Columns' },
];

export default function TextProperties({ element }) {
  const { onContentChange, selectElement } = useElementSelection();

  const [elementType, setElementType] = useState(() => element?.tagName || 'P');
  const [alignment, setAlignment] = useState(() => element?.style.textAlign || 'left');
  const [color, setColor] = useState(() => element?.style.color || 'inherit');
  const [fontSize, setFontSize] = useState(() => element?.style.fontSize || '');
  const [columns, setColumns] = useState(() => getListColumns(element));

  // Get column count from parent list (for list items)
  function getListColumns(el) {
    if (!el) return '1';
    // If this is a list item, check parent list's column-count
    if (el.tagName === 'LI') {
      const parentList = el.closest('ul, ol');
      if (parentList) {
        return parentList.style.columnCount || '1';
      }
    }
    return '1';
  }

  // Sync state when element changes
  useEffect(() => {
    if (element) {
      setElementType(element.tagName);
      setAlignment(element.style.textAlign || 'left');
      setColor(element.style.color || 'inherit');
      setFontSize(element.style.fontSize || '');
      setColumns(getListColumns(element));
    }
  }, [element]);

  // Change element type (e.g., h1 → h2, h1 → p, or h1 → code block)
  const handleElementTypeChange = useCallback((newType) => {
    if (!element || element.tagName === newType) return;

    // List items can't be converted to other types (they must stay in lists)
    if (element.tagName === 'LI') return;

    let newElement;

    if (newType === 'CODE') {
      // Special case: convert to code block (<pre><code>)
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-javascript';
      code.textContent = element.textContent || '// Your code here';
      pre.appendChild(code);
      newElement = pre;
    } else {
      // Standard element conversion
      newElement = document.createElement(newType.toLowerCase());

      // Copy innerHTML (preserves nested content like <strong>, <em>, etc.)
      newElement.innerHTML = element.innerHTML;

      // Copy over styles
      newElement.style.cssText = element.style.cssText;

      // Copy over any classes
      newElement.className = element.className;
    }

    // Replace in DOM
    element.parentNode.replaceChild(newElement, element);

    // Update state and selection
    setElementType(newType);
    selectElement(newElement);
    onContentChange?.();
  }, [element, selectElement, onContentChange]);

  // Update alignment
  const handleAlignmentChange = useCallback((newAlign) => {
    if (!element) return;
    element.style.textAlign = newAlign === 'left' ? '' : newAlign;
    setAlignment(newAlign);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update color
  const handleColorChange = useCallback((newColor) => {
    if (!element) return;
    element.style.color = newColor === 'inherit' ? '' : newColor;
    setColor(newColor);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update font size
  const handleFontSizeChange = useCallback((newSize) => {
    if (!element) return;
    element.style.fontSize = newSize;
    setFontSize(newSize);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update columns (for list items - applies to parent list)
  const handleColumnsChange = useCallback((newColumns) => {
    if (!element || element.tagName !== 'LI') return;

    const parentList = element.closest('ul, ol');
    if (!parentList) return;

    if (newColumns === '1') {
      // Remove column styles
      parentList.style.columnCount = '';
      parentList.style.columnGap = '';
    } else {
      // Apply column styles
      parentList.style.columnCount = newColumns;
      parentList.style.columnGap = '2em';
    }

    setColumns(newColumns);
    onContentChange?.();
  }, [element, onContentChange]);

  if (!element) {
    return null;
  }

  // Determine element type for display
  const elementLabel = {
    H1: 'Heading 1',
    H2: 'Heading 2',
    H3: 'Heading 3',
    P: 'Paragraph',
    LI: 'List Item',
  }[element.tagName] || 'Text';

  // Check if element type can be changed (list items can't)
  const canChangeType = element.tagName !== 'LI';

  // Check if this is a list item (can have columns)
  const isListItem = element.tagName === 'LI';

  return (
    <div className="space-y-4">
      <PropertySection title={elementLabel}>
        {/* Element type selector */}
        {canChangeType && (
          <div>
            <PropertyLabel>Element Type</PropertyLabel>
            <Select
              value={elementType}
              onChange={handleElementTypeChange}
              options={ELEMENT_TYPES}
              className="w-full"
              size="small"
            />
          </div>
        )}

        {/* Alignment buttons */}
        <div>
          <PropertyLabel>Alignment</PropertyLabel>
          <div className="flex gap-1">
            {ALIGNMENTS.map((align) => (
              <button
                key={align.value}
                onClick={() => handleAlignmentChange(align.value)}
                className={`flex-1 px-2 py-1.5 text-sm rounded border transition-colors ${
                  alignment === align.value
                    ? 'bg-blue-100 border-blue-500 text-blue-700 dark:bg-blue-900 dark:border-blue-400 dark:text-blue-200'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-600'
                }`}
                title={align.label}
              >
                {align.icon}
              </button>
            ))}
          </div>
        </div>

        {/* Color picker */}
        <div>
          <PropertyLabel>Color</PropertyLabel>
          <div className="flex flex-wrap gap-1">
            {COLORS.map((c) => (
              <button
                key={c.value}
                onClick={() => handleColorChange(c.value)}
                className={`w-6 h-6 rounded border-2 transition-transform ${
                  color === c.value
                    ? 'border-blue-500 scale-110'
                    : 'border-gray-300 dark:border-gray-600 hover:scale-105'
                }`}
                style={{
                  backgroundColor: c.value === 'inherit' ? 'transparent' : c.value,
                  backgroundImage: c.value === 'inherit'
                    ? 'linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%), linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%)'
                    : 'none',
                  backgroundSize: '8px 8px',
                  backgroundPosition: '0 0, 4px 4px',
                }}
                title={c.label}
              />
            ))}
          </div>
        </div>

        {/* Font size */}
        <div>
          <PropertyLabel>Font Size</PropertyLabel>
          <Select
            value={fontSize}
            onChange={handleFontSizeChange}
            options={FONT_SIZES}
            className="w-full"
            size="small"
          />
        </div>

        {/* Columns (only for list items) */}
        {isListItem && (
          <div>
            <PropertyLabel>List Columns</PropertyLabel>
            <Select
              value={columns}
              onChange={handleColumnsChange}
              options={COLUMN_OPTIONS}
              className="w-full"
              size="small"
            />
            <p className="text-xs text-gray-400 mt-1">Flows list items into columns</p>
          </div>
        )}

      </PropertySection>

      {/* Convert to draggable block */}
      {canConvertToBlock(element) && (
        <PropertySection title="Layout">
          <button
            onClick={() => convertToBlock(element, selectElement, onContentChange)}
            className="w-full px-3 py-2 text-sm bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-sm hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
          >
            📦 Convert to Draggable Block
          </button>
          <p className="text-xs text-gray-400 mt-1">
            Move freely with absolute positioning
          </p>
        </PropertySection>
      )}
    </div>
  );
}
