import { useState, useCallback, useEffect } from 'react';
import { Select } from 'antd';
import PropertySection, { PropertyRow, PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import { stripHighlightSpans } from '../utils/codeBlockUtils';
import { convertToBlock, canConvertToBlock } from '../utils/convertToBlock';

/**
 * CodeBlockProperties - Property editor for code blocks
 *
 * Allows configuring:
 * - Programming language (for syntax highlighting)
 * - Line numbers toggle
 *
 * Also handles:
 * - Stripping syntax highlighting when editing (for clean contenteditable)
 * - Tab key for indentation
 * - Enter key with auto-indent
 *
 * Note: Code theme is configured at the presentation level in SlideProperties.
 * Re-highlighting happens automatically when exiting edit mode
 * (RevealSlides re-initializes with RevealHighlight plugin)
 */

const LANGUAGES = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'csharp', label: 'C#' },
  { value: 'cpp', label: 'C++' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'sql', label: 'SQL' },
  { value: 'bash', label: 'Bash/Shell' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'plaintext', label: 'Plain Text' },
];

/**
 * Extract language from class name (e.g., 'language-javascript' -> 'javascript')
 */
function getLanguageFromClass(className) {
  const match = className?.match(/language-(\w+)/);
  return match ? match[1] : 'javascript';
}


export default function CodeBlockProperties({ element }) {
  const { onContentChange, selectElement } = useElementSelection();
  const codeEl = element?.querySelector('code');

  const [language, setLanguage] = useState(() => getLanguageFromClass(codeEl?.className));
  const [showLineNumbers, setShowLineNumbers] = useState(() =>
    element?.hasAttribute('data-line-numbers')
  );

  // Sync state when element changes
  useEffect(() => {
    if (codeEl) {
      setLanguage(getLanguageFromClass(codeEl.className));
    }
    if (element) {
      setShowLineNumbers(element.hasAttribute('data-line-numbers'));
    }
  }, [element, codeEl]);

  // Strip highlight spans when this code block is selected for editing
  // This gives us clean plain text for contenteditable
  useEffect(() => {
    // Get codeEl fresh inside the effect to ensure we have the latest reference
    const codeElement = element?.querySelector('code');
    if (!codeElement) return;

    // Only strip if the code is still highlighted (has 'hljs' class)
    // This prevents re-stripping on every render which causes cursor flickering
    if (codeElement.classList.contains('hljs')) {
      // Use requestAnimationFrame to defer stripping until after the browser
      // has processed the click and set up the cursor position
      requestAnimationFrame(() => {
        // Double-check the element still exists and has hljs class
        if (codeElement.classList.contains('hljs')) {
          stripHighlightSpans(codeElement);
        }
      });
    }

    // NOTE: We do NOT re-highlight here or on unmount.
    // Re-highlighting happens automatically when exiting edit mode - RevealSlides
    // re-initializes with the RevealHighlight plugin when isEditing becomes false.
  }, [element]); // Use element as dependency, not codeEl

  // NOTE: Keyboard handlers (Tab/Enter) are handled at the deck level in RevealSlides.jsx
  // because contenteditable is on the <section>, not the <code> element.

  // Update language class
  const handleLanguageChange = useCallback((newLang) => {
    if (!codeEl) return;

    // Remove existing language class and add new one
    codeEl.className = codeEl.className.replace(/language-\w+/, '');
    codeEl.classList.add(`language-${newLang}`);
    setLanguage(newLang);
    onContentChange?.();
  }, [codeEl, onContentChange]);

  // Toggle line numbers
  const handleLineNumbersChange = useCallback((e) => {
    if (!element) return;

    if (e.target.checked) {
      element.setAttribute('data-line-numbers', '');
    } else {
      element.removeAttribute('data-line-numbers');
    }
    setShowLineNumbers(e.target.checked);
    onContentChange?.();
  }, [element, onContentChange]);

  if (!element || !codeEl) {
    return null;
  }

  return (
    <div className="space-y-4">
      <PropertySection title="Code Block">
        <div>
          <PropertyLabel>Language</PropertyLabel>
          <Select
            value={language}
            onChange={handleLanguageChange}
            options={LANGUAGES}
            className="w-full"
            size="small"
            showSearch
            filterOption={(input, option) =>
              option.label.toLowerCase().includes(input.toLowerCase())
            }
          />
        </div>

        <PropertyRow label="Line numbers">
          <input
            type="checkbox"
            checked={showLineNumbers}
            onChange={handleLineNumbersChange}
            className="h-4 w-4 text-blue-600 rounded-sm border-gray-300 focus:ring-blue-500"
          />
        </PropertyRow>
      </PropertySection>

      <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 px-1">
        Syntax highlighting will re-apply when you save.
      </p>

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
