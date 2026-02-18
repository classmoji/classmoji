import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { extractBodyContent } from './content.server.js';

/**
 * Parse CSS background colors from the <style> block.
 * Extracts background-color rules for h1, h2, h3 elements.
 *
 * @param {string} html - Full HTML document
 * @returns {Object} Map of heading level to background color (e.g., { 1: '#FBF3DB', 2: '#DDEBF1' })
 */
function parseCssBackgroundColors(html) {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleMatch) return {};

  const cssContent = styleMatch[1];
  const colorMap = {};

  // Match h1/h2/h3 background-color rules
  const h1Match = cssContent.match(/h1\s*\{[^}]*background-color:\s*([^;]+)/i);
  const h2Match = cssContent.match(/h2\s*\{[^}]*background-color:\s*([^;]+)/i);
  const h3Match = cssContent.match(/h3\s*\{[^}]*background-color:\s*([^;]+)/i);

  if (h1Match) colorMap[1] = h1Match[1].trim();
  if (h2Match) colorMap[2] = h2Match[1].trim();
  if (h3Match) colorMap[3] = h3Match[1].trim();

  return colorMap;
}

/**
 * Migrate HTML content to BlockNote JSON format.
 *
 * Uses BlockNote's built-in HTML parser for standard elements,
 * then post-processes to map known CSS classes from the existing
 * MarkdownEditor blocks to custom BlockNote block types.
 *
 * This migration is intentionally lossy — some formatting nuances
 * from the custom HTML blocks may not survive conversion. The
 * original HTML is preserved on GitHub for reference.
 *
 * @param {string} html - Full HTML document or body content
 * @param {Object} schema - BlockNote schema with custom blocks
 * @returns {Promise<Array>} BlockNote document blocks
 */
export async function migrateHtmlToBlockNote(html, schema) {
  // Extract body content from full HTML document
  let bodyHtml = extractBodyContent(html);

  if (!bodyHtml) {
    return [{ type: 'paragraph', content: [] }];
  }

  // Pre-process: Replace video-embed divs with special paragraphs that BlockNote will parse
  // This is needed because BlockNote ignores unknown custom HTML elements
  // Embed the URL directly in the text since BlockNote doesn't preserve data attributes

  // Handle iframe embeds (YouTube, Vimeo, etc.)
  bodyHtml = bodyHtml.replace(
    /<div class="video-embed">\s*<iframe[^>]*src="([^"]*)"[^>]*><\/iframe>\s*<\/div>/g,
    '<p class="VIDEO_EMBED_PLACEHOLDER">VIDEO_EMBED:::$1</p>'
  );

  // Handle native <video> tags with <source> children
  bodyHtml = bodyHtml.replace(
    /<div class="video-embed">\s*<video[^>]*>\s*<source\s+src="([^"]*)"[^>]*>[^<]*<\/video>\s*<\/div>/g,
    '<p class="VIDEO_EMBED_PLACEHOLDER">VIDEO_EMBED:::$1</p>'
  );

  // Handle native <video> tags with direct src attribute
  bodyHtml = bodyHtml.replace(
    /<div class="video-embed">\s*<video[^>]*src="([^"]*)"[^>]*>[^<]*<\/video>\s*<\/div>/g,
    '<p class="VIDEO_EMBED_PLACEHOLDER">VIDEO_EMBED:::$1</p>'
  );

  // Parse CSS background colors from original HTML (before body extraction)
  const cssBackgroundColors = parseCssBackgroundColors(html);

  // Create a server-side editor with our custom schema
  const editor = ServerBlockNoteEditor.create({ schema });

  // Use BlockNote's built-in HTML parser
  const blocks = await editor.tryParseHTMLToBlocks(bodyHtml);

  // Post-process: map known CSS class patterns to custom block types
  return postProcessBlocks(blocks, cssBackgroundColors);
}

/**
 * Post-process parsed blocks to detect custom block patterns
 * from the existing MarkdownEditor HTML output.
 *
 * BlockNote's HTML parser wraps unrecognized elements in paragraphs.
 * We need to detect these patterns and convert them to proper custom blocks.
 *
 * @param {Array} blocks - BlockNote blocks from HTML parser
 * @param {Object} cssBackgroundColors - Map of heading level to background color
 * @returns {Array} Processed blocks with custom block types
 */
function postProcessBlocks(blocks, cssBackgroundColors = {}) {
  const result = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Skip spurious paragraphs before code/terminal blocks
    // These are from code block headers (language name + line numbers)
    if (block.type === 'paragraph' && i + 1 < blocks.length) {
      const textContent = getBlockTextContent(block).trim();
      const nextBlock = blocks[i + 1];

      // Check if this paragraph is just a language name and/or numbers
      // Pattern matches: "JavaScript", "JavaScript 123", "1234567", etc.
      const matchesPattern = /^(?:[a-z]+(?:[\s\n]+\d+)?|\d+)$/i.test(textContent);

      // Check if next block is code OR another spurious paragraph followed by code
      const nextIsCode = nextBlock.type === 'codeBlock' || nextBlock.type === 'terminal';
      const nextNextBlock = i + 2 < blocks.length ? blocks[i + 2] : null;
      const nextIsSuspiciousParagraph = nextBlock.type === 'paragraph' &&
                                       /^(?:[a-z]+(?:[\s\n]+\d+)?|\d+)$/i.test(getBlockTextContent(nextBlock).trim());
      const nextNextIsCode = nextNextBlock && (nextNextBlock.type === 'codeBlock' || nextNextBlock.type === 'terminal');

      if (matchesPattern && (nextIsCode || (nextIsSuspiciousParagraph && nextNextIsCode))) {
        // Skip this spurious header paragraph
        continue;
      }
    }

    // Handle heading blocks - apply CSS background colors
    if (block.type === 'heading') {
      // Add empty block before heading for spacing
      result.push({ type: 'paragraph', content: [] });

      // Apply CSS background color based on heading level
      const level = block.props?.level || 1;
      if (cssBackgroundColors[level]) {
        block.props = block.props || {};
        block.props.backgroundColor = mapColorToBlockNote(cssBackgroundColors[level]);
      }

      // Recursively process children
      if (block.children && block.children.length > 0) {
        block.children = postProcessBlocks(block.children, cssBackgroundColors);
      }
      result.push(block);
      continue;
    }

    // Convert codeBlock with powershell/bash language to terminal block
    if (block.type === 'codeBlock') {
      const language = block.props?.language?.toLowerCase();
      if (language === 'powershell' || language === 'bash') {
        const code = getBlockTextContent(block);
        result.push({
          type: 'terminal',
          props: {
            title: language === 'powershell' ? 'powershell' : 'Terminal',
            code: code
          }
        });
        continue;
      }
    }

    // Check for Terminal/powershell paragraph followed by code block pattern
    if (block.type === 'paragraph' && i + 1 < blocks.length) {
      const textContent = getBlockTextContent(block).trim();
      const nextBlock = blocks[i + 1];

      // If this paragraph contains "Terminal" or "powershell" and next block is a codeBlock, merge them
      const isTerminalBlock = textContent.toLowerCase().includes('terminal') ||
                             textContent.toLowerCase().includes('powershell');

      if (isTerminalBlock && nextBlock.type === 'codeBlock') {
        // Extract code from the next block
        const code = getBlockTextContent(nextBlock);

        // Create terminal block
        result.push({
          type: 'terminal',
          props: {
            title: textContent,
            code: code
          }
        });

        // Skip the next block since we merged it
        i++;
        continue;
      }
    }

    // Skip other non-paragraph blocks
    if (block.type !== 'paragraph') {
      // Recursively process children
      if (block.children && block.children.length > 0) {
        block.children = postProcessBlocks(block.children, cssBackgroundColors);
      }
      result.push(block);
      continue;
    }

    // Check for custom block patterns in paragraph content
    const textContent = getBlockTextContent(block);

    // 1. Video embed placeholder (from pre-processing)
    if (textContent.startsWith('VIDEO_EMBED:::')) {
      // Extract video URL from the text (format: VIDEO_EMBED:::URL)
      const videoUrl = textContent.substring('VIDEO_EMBED:::'.length).trim();
      if (videoUrl) {
        result.push({
          type: 'video',
          props: {
            url: videoUrl,
            caption: ''
          }
        });
        continue;
      }
    }

    // 2. Divider block (existing detection)
    if (textContent.trim() === '' && block.props?.className?.includes('divider')) {
      result.push({ type: 'divider', props: {} });
      continue;
    }

    // For blocks with HTML content, we need to parse it
    if (!block.content || !Array.isArray(block.content)) {
      result.push(block);
      continue;
    }

    // Check inline content for HTML patterns
    let blockHandled = false;
    for (const inlineItem of block.content) {
      if (inlineItem.type !== 'text' || !inlineItem.text) continue;

      const html = inlineItem.text;

      // 2. Terminal block detection (check before code-block for specificity)
      if (html.includes('class="terminal-block"')) {
        const titleMatch = html.match(/class="terminal-title">([^<]*)</);
        const title = titleMatch?.[1] || '';
        const codeMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
        const code = codeMatch?.[1] || '';

        // Terminal block has content: 'none', all data in props
        result.push({
          type: 'terminal',
          props: {
            title,
            code: decodeHtmlEntities(code)
          }
        });
        blockHandled = true;
        break;
      }

      // 3. Code block detection - check if it's a Terminal/powershell block
      if (html.includes('class="code-block"')) {
        const codeMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
        const code = codeMatch?.[1] || '';

        // Check for code-lang span with "powershell" or "terminal" (within code block header)
        const codeLangMatch = html.match(/<span class="code-lang">(terminal|powershell)<\/span>/i);

        if (codeLangMatch) {
          // Found powershell or terminal in code-lang span - create terminal block
          result.push({
            type: 'terminal',
            props: {
              title: codeLangMatch[1],
              code: decodeHtmlEntities(code)
            }
          });
          blockHandled = true;
          break;
        }

        // Check if "Terminal" or "powershell" appears before the code block (case-insensitive)
        const terminalMatch = html.match(/Terminal|powershell/i);
        const codeBlockIndex = html.indexOf('class="code-block"');

        if (terminalMatch && terminalMatch.index < codeBlockIndex) {
          // Extract Terminal/powershell title if present (text before keyword or use keyword as title)
          const beforeTerminal = html.substring(0, terminalMatch.index);
          const titleMatch = beforeTerminal.match(/>([^<]+)<[^>]*$/);
          const title = titleMatch?.[1]?.trim() || terminalMatch[0];

          result.push({
            type: 'terminal',
            props: {
              title,
              code: decodeHtmlEntities(code)
            }
          });
          blockHandled = true;
          break;
        }

        // Regular code block
        const langMatch = html.match(/class="language-(\w+)"/);
        const language = langMatch?.[1] || 'javascript';

        result.push({
          type: 'codeBlock',
          props: { language },
          content: [{ type: 'text', text: decodeHtmlEntities(code), styles: {} }]
        });
        blockHandled = true;
        break;
      }

      // 4. Callout block detection
      if (html.includes('class="callout"')) {
        const emojiMatch = html.match(/class="callout-emoji">([^<]*)</);
        const emoji = emojiMatch?.[1] || '💡';
        // Match content between emoji span and closing div
        const contentMatch = html.match(/callout-emoji">[^<]*<\/span>\s*<span>([\s\S]*?)<\/span>/);
        const text = contentMatch?.[1] || '';

        // Callout has content: 'inline', so it needs inline content array
        result.push({
          type: 'callout',
          props: { emoji },
          content: text ? [{ type: 'text', text, styles: {} }] : []
        });
        blockHandled = true;
        break;
      }

      // 5. Alert block detection → convert to callout
      if (html.includes('class="alert')) {
        const typeMatch = html.match(/data-type="(\w+)"/);
        const alertType = typeMatch?.[1] || 'info';
        const contentMatch = html.match(/<span>([\s\S]*?)<\/span>/);
        const content = contentMatch?.[1] || '';

        // Map alert types to emoji
        const emojiMap = {
          info: '💡',
          warning: '⚠️',
          error: '🚨',
          success: '✅',
          note: '📌'
        };

        result.push({
          type: 'callout',
          props: { emoji: emojiMap[alertType] || '💡' },
          content: content ? [{ type: 'text', text: content, styles: {} }] : []
        });
        blockHandled = true;
        break;
      }

      // 6. File tree block detection → convert to terminal
      if (html.includes('class="file-tree"')) {
        const titleMatch = html.match(/data-title="([^"]*)"/);
        const title = titleMatch?.[1] || 'File Structure';
        const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
        const tree = preMatch?.[1] || '';

        // Convert to terminal block (similar structure: title + code content)
        result.push({
          type: 'terminal',
          props: {
            title,
            code: decodeHtmlEntities(tree)
          }
        });
        blockHandled = true;
        break;
      }

      // 7. Diff block detection → convert to codeBlock
      if (html.includes('class="diff-block"')) {
        const dataMatch = html.match(/data-content="([^"]*)"/);
        let code = '';

        if (dataMatch) {
          try {
            // Decode base64 content
            code = decodeURIComponent(escape(atob(dataMatch[1])));
          } catch {
            // Fallback to pre content
            const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
            code = preMatch?.[1] || '';
          }
        } else {
          // No data-content, try pre content
          const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
          code = preMatch?.[1] || '';
        }

        // Convert to codeBlock with diff language
        result.push({
          type: 'codeBlock',
          props: {
            language: 'diff'
          },
          content: [{ type: 'text', text: decodeHtmlEntities(code), styles: {} }]
        });
        blockHandled = true;
        break;
      }
    }

    if (blockHandled) {
      continue;
    }

    // Recursively process children
    if (block.children && block.children.length > 0) {
      block.children = postProcessBlocks(block.children, cssBackgroundColors);
    }

    result.push(block);
  }

  return result;
}

/**
 * Map HTML color values to BlockNote color names.
 * BlockNote supports: default, gray, brown, red, orange, yellow, green, blue, purple, pink
 */
function mapColorToBlockNote(color) {
  const normalized = color.toLowerCase().trim();

  // Direct color name mapping
  const colorMap = {
    // Standard HTML color names
    'red': 'red',
    'orange': 'orange',
    'yellow': 'yellow',
    'green': 'green',
    'blue': 'blue',
    'purple': 'purple',
    'pink': 'pink',
    'gray': 'gray',
    'grey': 'gray',
    'brown': 'brown',

    // Common hex values
    '#ff0000': 'red',
    '#ffa500': 'orange',
    '#ffff00': 'yellow',
    '#00ff00': 'green',
    '#0000ff': 'blue',
    '#800080': 'purple',
    '#ffc0cb': 'pink',
    '#808080': 'gray',
    '#a52a2a': 'brown',

    // Light variants
    '#ffeb3b': 'yellow',
    '#fff9c4': 'yellow',
    '#f44336': 'red',
    '#ff5722': 'orange',
    '#4caf50': 'green',
    '#2196f3': 'blue',
    '#9c27b0': 'purple',
    '#e91e63': 'pink',
  };

  if (colorMap[normalized]) {
    return colorMap[normalized];
  }

  // Try to detect color from hex value
  if (normalized.startsWith('#')) {
    // Simple heuristic based on hex values
    const hex = normalized.slice(1);
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);

      // Detect dominant color
      if (r > g && r > b) return 'red';
      if (g > r && g > b) return 'green';
      if (b > r && b > g) return 'blue';
      if (r > 200 && g > 200 && b < 100) return 'yellow';
      if (r > 200 && g < 150 && b > 150) return 'pink';
      if (r > 150 && g < 100 && b > 150) return 'purple';
      if (r > 200 && g > 100 && g < 180 && b < 100) return 'orange';
      if (r < 150 && g < 150 && b < 150) return 'gray';
    }
  }

  // Default to gray for unknown colors
  return 'gray';
}

/**
 * Decode HTML entities like &lt; &gt; &amp;
 */
function decodeHtmlEntities(text) {
  const entities = {
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'"
  };

  return text.replace(/&[^;]+;/g, match => entities[match] || match);
}

/**
 * Extract plain text content from a block's inline content array.
 */
function getBlockTextContent(block) {
  if (!block.content || !Array.isArray(block.content)) return '';
  return block.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('');
}

