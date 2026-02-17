/**
 * Code Block Utilities
 *
 * Handles stripping/restoring syntax highlighting for contenteditable editing.
 * Pattern: "Edit Raw, View Highlighted"
 */

/**
 * Strip highlight.js spans from a code element, leaving only plain text.
 * Call this when a code block gains focus for editing.
 *
 * @param {HTMLElement} codeElement - The <code> element inside a <pre>
 * @returns {string} The plain text content (for potential undo)
 */
export function stripHighlightSpans(codeElement) {
  if (!codeElement) return '';

  // Get the plain text content (this strips all HTML tags)
  const plainText = codeElement.textContent || '';

  // Replace innerHTML with just the plain text
  // This removes all <span class="hljs-*"> elements
  codeElement.innerHTML = plainText;

  // Remove the hljs class that highlight.js adds
  codeElement.classList.remove('hljs');

  return plainText;
}

/**
 * Re-apply syntax highlighting to a code element.
 * Call this when a code block loses focus after editing.
 *
 * @param {HTMLElement} codeElement - The <code> element inside a <pre>
 */
export async function reHighlightCode(codeElement) {
  if (!codeElement) return;

  // Dynamically import highlight.js
  const hljs = (await import('highlight.js/lib/core')).default;

  // Import common languages
  const [
    javascript,
    typescript,
    python,
    java,
    cpp,
    c,
    xml,
    css,
    json,
    sql,
    bash,
    go,
    rust,
    ruby,
    php,
    swift,
  ] = await Promise.all([
    import('highlight.js/lib/languages/javascript'),
    import('highlight.js/lib/languages/typescript'),
    import('highlight.js/lib/languages/python'),
    import('highlight.js/lib/languages/java'),
    import('highlight.js/lib/languages/cpp'),
    import('highlight.js/lib/languages/c'),
    import('highlight.js/lib/languages/xml'),
    import('highlight.js/lib/languages/css'),
    import('highlight.js/lib/languages/json'),
    import('highlight.js/lib/languages/sql'),
    import('highlight.js/lib/languages/bash'),
    import('highlight.js/lib/languages/go'),
    import('highlight.js/lib/languages/rust'),
    import('highlight.js/lib/languages/ruby'),
    import('highlight.js/lib/languages/php'),
    import('highlight.js/lib/languages/swift'),
  ]);

  // Register languages
  hljs.registerLanguage('javascript', javascript.default);
  hljs.registerLanguage('typescript', typescript.default);
  hljs.registerLanguage('python', python.default);
  hljs.registerLanguage('java', java.default);
  hljs.registerLanguage('cpp', cpp.default);
  hljs.registerLanguage('c', c.default);
  hljs.registerLanguage('html', xml.default);
  hljs.registerLanguage('xml', xml.default);
  hljs.registerLanguage('css', css.default);
  hljs.registerLanguage('json', json.default);
  hljs.registerLanguage('sql', sql.default);
  hljs.registerLanguage('bash', bash.default);
  hljs.registerLanguage('go', go.default);
  hljs.registerLanguage('rust', rust.default);
  hljs.registerLanguage('ruby', ruby.default);
  hljs.registerLanguage('php', php.default);
  hljs.registerLanguage('swift', swift.default);

  // Get the language from the class (e.g., "language-javascript")
  const languageClass = Array.from(codeElement.classList)
    .find(cls => cls.startsWith('language-'));
  const language = languageClass ? languageClass.replace('language-', '') : null;

  // Get plain text content
  const code = codeElement.textContent || '';

  // Highlight the code
  let result;
  if (language && hljs.getLanguage(language)) {
    result = hljs.highlight(code, { language });
  } else {
    result = hljs.highlightAuto(code);
  }

  // Update the element with highlighted HTML
  codeElement.innerHTML = result.value;
  codeElement.classList.add('hljs');
}

/**
 * Handle Tab key in a code block - insert indentation instead of moving focus.
 *
 * @param {KeyboardEvent} event - The keydown event
 * @param {HTMLElement} codeElement - The <code> element
 * @param {Function} onContentChange - Callback when content changes
 */
export function handleCodeBlockTab(event, codeElement, onContentChange) {
  if (event.key !== 'Tab') return;

  event.preventDefault();

  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  const range = selection.getRangeAt(0);

  // Check if we're inside the code element
  if (!codeElement.contains(range.startContainer)) return;

  if (event.shiftKey) {
    // Shift+Tab: remove indentation (if at start of line)
    // For simplicity, we'll just prevent default for now
    // A full implementation would remove leading whitespace
    return;
  }

  // Insert a tab character (or spaces - using 2 spaces here)
  const indent = '  '; // 2 spaces

  // Delete any selected text first
  range.deleteContents();

  // Insert the indentation
  const textNode = document.createTextNode(indent);
  range.insertNode(textNode);

  // Move cursor after the inserted text
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);

  // Notify of content change
  onContentChange?.();
}

/**
 * Handle Enter key in a code block - maintain indentation.
 *
 * @param {KeyboardEvent} event - The keydown event
 * @param {HTMLElement} codeElement - The <code> element
 * @param {Function} onContentChange - Callback when content changes
 */
export function handleCodeBlockEnter(event, codeElement, onContentChange) {
  if (event.key !== 'Enter') return;

  event.preventDefault();

  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  const range = selection.getRangeAt(0);

  // Get current line's indentation
  const text = codeElement.textContent || '';
  const cursorPos = getCaretPosition(codeElement);

  // Find the start of the current line
  let lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1;

  // Get the whitespace at the start of the current line
  let indent = '';
  for (let i = lineStart; i < text.length; i++) {
    const char = text[i];
    if (char === ' ' || char === '\t') {
      indent += char;
    } else {
      break;
    }
  }

  // Delete any selected text
  range.deleteContents();

  // Insert newline + indentation
  const textNode = document.createTextNode('\n' + indent);
  range.insertNode(textNode);

  // Move cursor after the inserted text
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);

  onContentChange?.();
}

/**
 * Get caret position within a contenteditable element.
 */
function getCaretPosition(element) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return 0;

  const range = selection.getRangeAt(0);
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(element);
  preCaretRange.setEnd(range.startContainer, range.startOffset);

  return preCaretRange.toString().length;
}
