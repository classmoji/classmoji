import { marked } from 'marked';
import * as prettier from 'prettier';

/**
 * Format code blocks in markdown using Prettier
 * Supports: JavaScript, TypeScript, HTML, CSS, JSON, Markdown
 *
 * Best-effort:
 * - If language is unsupported or formatting fails, the block is left unchanged
 * - Handles CRLF, ``` and ~~~ fences, and info strings like: ```js title="x"
 */
export async function formatCodeBlocks(markdown) {
  // Map language hints to Prettier parsers
  const parserMap = {
    js: 'babel',
    javascript: 'babel',
    jsx: 'babel',
    ts: 'babel-ts',
    typescript: 'babel-ts',
    // Use babel-ts for TS/TSX snippets (matches editor behavior, handles JSX in TSX).
    tsx: 'babel-ts',
    'babel-ts': 'babel-ts',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    md: 'markdown',
    markdown: 'markdown',
  };

  const formatWithParser = async (code, parser) => {
    const formatted = await prettier.format(code, {
      parser,
      semi: true,
      singleQuote: true,
      tabWidth: 2,
      printWidth: 80,
    });
    return formatted.trimEnd();
  };

  const normalizeLangToken = token => {
    if (!token) return '';
    let t = token.trim().toLowerCase();
    // Common prefixes from some exporters/highlighters.
    if (t.startsWith('language-')) t = t.slice('language-'.length);
    // Support `{.language-js}` style (Pandoc-ish).
    t = t.replace(/^\{\.\s*/, '').replace(/\s*\}$/, '');
    if (t.startsWith('language-')) t = t.slice('language-'.length);
    return t;
  };

  const guessParser = (langToken, code) => {
    const normalizedToken = normalizeLangToken(langToken);
    if (normalizedToken) {
      // Match editor behavior: typescript -> babel-ts (handles TSX better).
      if (normalizedToken === 'ts' || normalizedToken === 'typescript') return 'babel-ts';
      return parserMap[normalizedToken] || null;
    }

    const trimmed = code.trimStart();
    // Heuristic: JSON blocks often have no language
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
    // Heuristic: HTML blocks often have no language
    if (/^<[a-zA-Z!/?]/.test(trimmed)) return 'html';
    return null;
  };

  // Parse fenced code blocks (``` or ~~~), including CRLF, and info strings.
  // We rebuild the output using indices to avoid accidental global replace collisions.
  const usesCrlf = markdown.includes('\r\n');
  const src = markdown.replace(/\r\n/g, '\n');
  let out = '';
  let idx = 0;

  // Matches opening fence line at start of a line:
  // ```lang other stuff
  // ...code...
  // ```
  const openRe = /(^|\n)([ \t]*)(```+|~~~+)([^\n]*)\n/gm;
  let m;

  while ((m = openRe.exec(src)) !== null) {
    const matchStart = m.index + (m[1] ? m[1].length : 0); // beginning of fence line
    const indent = m[2] || '';
    const fence = m[3];
    const infoRaw = m[4] || '';
    const infoTrimmed = infoRaw.trim();
    const openFenceLen = fence.length;
    const langToken = infoTrimmed ? infoTrimmed.split(/\s+/)[0] : '';
    const codeStart = m.index + m[0].length;

    // Append everything up to the opening fence
    out += src.slice(idx, matchStart);

    // Find closing fence: must be same char (` or ~), and at least same length.
    // We'll scan line-by-line from codeStart.
    let scan = codeStart;
    let closeStart = -1;
    let closeEnd = -1;
    while (scan < src.length) {
      const lineEnd = src.indexOf('\n', scan);
      const nextLineEnd = lineEnd === -1 ? src.length : lineEnd + 1;
      const line = src.slice(scan, lineEnd === -1 ? src.length : lineEnd);

      // Closing fence must start at line start and be all fence chars (plus optional spaces)
      const trimmedLine = line.trim();
      const isBacktick = fence[0] === '`';
      const candidateChar = isBacktick ? '`' : '~';
      if (
        trimmedLine.length >= openFenceLen &&
        trimmedLine.split('').every(ch => ch === candidateChar)
      ) {
        closeStart = scan;
        closeEnd = nextLineEnd;
        break;
      }

      scan = nextLineEnd;
    }

    // If no closing fence found, treat as normal text and continue
    if (closeStart === -1) {
      out += src.slice(matchStart, codeStart);
      idx = codeStart;
      continue;
    }

    const rawCode = src.slice(codeStart, closeStart);
    const code = rawCode.replace(/\s+$/g, ''); // keep leading whitespace; trim trailing only

    // Best-effort formatting
    const parser = guessParser(langToken, code);
    let formattedCode = null;

    if (parser && code.trim()) {
      try {
        formattedCode = await formatWithParser(code, parser);
      } catch (err) {
        console.log(err);
        // JSX snippet fallback: wrap in fragment if it looks like JSX and fails due to adjacency.
        const normalizedLang = normalizeLangToken(langToken);
        const isJsxish =
          (normalizedLang && ['jsx', 'tsx'].includes(normalizedLang)) ||
          parser === 'babel' ||
          parser === 'babel-ts';
        const looksLikeJsx = code.trimStart().startsWith('<');
        const msg = err?.message || '';

        if (isJsxish && looksLikeJsx && msg.includes('Adjacent JSX elements')) {
          try {
            const wrapped = `const __cm_tmp = (\n<>\n${code.trimEnd()}\n</>\n);\n`;
            const wrappedFormatted = await formatWithParser(wrapped, parser);
            const lines = wrappedFormatted.split('\n');

            const openIdx = lines.findIndex(l => l.trim() === '<>');
            const closeIdx = (() => {
              for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].trim() === '</>') return i;
              }
              return -1;
            })();

            if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
              const inner = lines.slice(openIdx + 1, closeIdx);
              const nonEmpty = inner.filter(l => l.trim().length > 0);
              const minIndent =
                nonEmpty.length === 0
                  ? 0
                  : Math.min(
                      ...nonEmpty.map(l => {
                        const m = l.match(/^\s*/);
                        return m ? m[0].length : 0;
                      })
                    );
              formattedCode = inner
                .map(l => (minIndent ? l.slice(minIndent) : l))
                .join('\n')
                .trimEnd();
            }
          } catch {
            // ignore
          }
        }
      }
    }

    // Rebuild block (use original fence and info line)
    // Preserve indentation for nested code blocks (e.g., inside list items)
    const finalCode = formattedCode ?? code;
    const indentedCode = indent
      ? finalCode
          .split('\n')
          .map(line => (line ? indent + line : line))
          .join('\n')
      : finalCode;

    out += `${indent}${fence}${infoRaw}\n`;
    out += `${indentedCode}\n`;
    out += `${indent}${fence}\n`;

    idx = closeEnd;
    openRe.lastIndex = closeEnd;
  }

  out += src.slice(idx);
  // Preserve original newline style if input used CRLF.
  return usesCrlf ? out.replace(/\n/g, '\r\n') : out;
}

/**
 * Normalize markdown from different sources
 * Add new adapters here as needed
 */
export function normalizeMarkdown(markdown) {
  let normalized = markdown;

  // Notion: Remove HTML comments (e.g., <!-- notionvc: ... -->)
  normalized = normalized.replace(/<!--[\s\S]*?-->/g, '');

  // Obsidian: Convert image wikilinks ![[image.png]] → ![](image.png)
  normalized = normalized.replace(/!\[\[([^\]]+)\]\]/g, '![]($1)');

  // Obsidian: Convert note wikilinks [[Page]] → **Page** (preserve as bold text)
  // normalized = normalized.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, page, alias) => `**${alias || page}**`);

  return normalized;
}

/**
 * Extract first H1 from markdown for use as title
 * Cleans up Notion-specific artifacts like HTML comments
 */
export function extractTitleFromMarkdown(markdown) {
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  if (!h1Match) return null;

  let title = h1Match[1].trim();

  // Remove Notion HTML comments (e.g., <!-- notionvc: b57374d5-409e-4c35-a161-1df68a673c08 -->)
  title = title.replace(/<!--[\s\S]*?-->/g, '').trim();

  return title;
}

/**
 * Extract image references from markdown
 * Returns array of { alt, path } objects
 * Handles paths with parentheses and URL-encoded characters
 */
export function extractImageReferences(markdown) {
  // Match image syntax - use non-greedy match up to .extension)
  // This handles paths like: Short%202%20Starterpack%20(Vite)/image.png
  // The key is matching .*? (non-greedy) followed by the extension and closing paren
  const imageRegex = /!\[([^\]]*)\]\((.*?\.(?:png|jpg|jpeg|gif|svg|webp))\)/gi;
  const images = [];
  let match;

  while ((match = imageRegex.exec(markdown)) !== null) {
    let path = match[2];
    // Decode URL-encoded paths
    try {
      path = decodeURIComponent(path);
    } catch {
      // If decoding fails, use as-is
    }
    images.push({
      alt: match[1],
      path: path,
    });
  }

  return images;
}

/**
 * Match image references in markdown to uploaded files
 * Returns a map: { originalPath -> uploadedFile }
 */
export function matchImageReferences(markdown, uploadedImages) {
  const references = extractImageReferences(markdown);
  const imageMap = new Map();

  references.forEach(ref => {
    // Extract just the filename from the path (handle paths like "folder/image.png")
    const refFilename = ref.path.split('/').pop().toLowerCase();

    // Find matching uploaded file (case-insensitive)
    const matchedFile = uploadedImages.find(file =>
      file.name.toLowerCase() === refFilename
    );

    if (matchedFile) {
      imageMap.set(ref.path, matchedFile);
    }
  });

  return imageMap;
}

/**
 * Process Notion toggle lists (collapsible content)
 *
 * Notion exports toggles as:
 * - ❓ Toggle title (often starts with emoji)
 *
 *     Indented paragraph content (NOT nested list items)
 *     Can include code blocks, paragraphs, etc.
 *
 * Detection criteria (ALL must be true):
 * 1. List item starts with emoji (common Notion toggle pattern)
 * 2. Followed by 4-space indented content
 * 3. Indented content is NOT a nested list (doesn't start with - * +)
 *
 * Regular markdown with indented content under list items is left as-is.
 *
 * Converts to <details><summary>...</summary><div>...</div></details>
 */
export function processToggleLists(markdown) {
  const lines = markdown.split('\n');
  const result = [];
  let i = 0;

  // Common toggle emoji patterns (Notion uses these for collapsible sections)
  const toggleEmojiPattern = /^(❓|💡|⚠️|📝|✅|❌|🔥|📌|👉|🎯|📚|🛠️|🔔|⭐|💻|🚀|👽|📦|🔧|💭|🤔|❗|ℹ️|🎨|🔍|📋|✨|🎁|🔒|🔓|⏰|📍|🏷️|📖|🔖|🗂️)/;

  while (i < lines.length) {
    const line = lines[i];

    // Check for list item that starts with emoji (Notion toggle pattern)
    const toggleMatch = line.match(/^- (.+)$/);

    if (toggleMatch) {
      const toggleTitle = toggleMatch[1];

      // Only treat as toggle if it starts with a common toggle emoji
      if (!toggleEmojiPattern.test(toggleTitle)) {
        result.push(line);
        i++;
        continue;
      }

      let innerContent = [];
      let j = i + 1;
      let inCodeBlock = false;

      // Skip any empty lines immediately after the list item
      while (j < lines.length && lines[j] === '') {
        j++;
      }

      // Check if there's 4-space indented content (Notion uses 4 spaces)
      if (j < lines.length && lines[j].startsWith('    ')) {
        // Check if this is a nested LIST vs toggle CONTENT
        const firstIndentedLine = lines[j].slice(4);
        const isNestedList = /^[-*+]\s/.test(firstIndentedLine);

        if (isNestedList) {
          // This is a nested list, not a toggle - leave it as-is
          result.push(line);
          i++;
          continue;
        }

        // This is a toggle block - collect all indented content
        j = i + 1;

        while (j < lines.length) {
          const nextLine = lines[j];

          // Track code block state (after removing indentation)
          const unindentedLine = nextLine.startsWith('    ') ? nextLine.slice(4) : nextLine;
          if (unindentedLine.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
          }

          // Check if this line is indented (part of toggle content) or we're in a code block
          if (nextLine.startsWith('    ') || inCodeBlock) {
            // Remove the 4-space indentation (if present)
            if (nextLine.startsWith('    ')) {
              innerContent.push(nextLine.slice(4));
            } else if (inCodeBlock) {
              // Inside code block, keep the line as-is
              innerContent.push(nextLine);
            }
            j++;
          } else if (nextLine === '') {
            // Empty line - check if toggle content continues after it
            if (inCodeBlock) {
              innerContent.push('');
              j++;
              continue;
            }

            // Look ahead to see if indented content continues
            let k = j + 1;
            while (k < lines.length && lines[k] === '') k++;

            if (k < lines.length && lines[k].startsWith('    ')) {
              // Content continues after empty line(s)
              innerContent.push('');
              j++;
            } else {
              // End of toggle content
              break;
            }
          } else {
            // Not indented and not in code block, end of toggle content
            break;
          }
        }

        // We have collected inner content - convert to toggle
        if (innerContent.length > 0 && innerContent.some(l => l.trim() !== '')) {
          // Convert inner content back to markdown, then to HTML
          const innerMarkdown = innerContent.join('\n').trim();
          const innerHtml = marked(innerMarkdown, {
            breaks: false, // Don't convert single newlines to <br> - breaks code blocks
            gfm: true,
            mangle: false,
            headerIds: false,
          });

          // Base64 encode the inner HTML to preserve it through DOM parsing
          // This prevents the browser from modifying the HTML structure
          const encodedInnerHtml = Buffer.from(innerHtml).toString('base64');

          // Output as details/summary (toggle format) with encoded inner content
          result.push(`<details><summary>${toggleTitle}</summary><div data-encoded="${encodedInnerHtml}"></div></details>`);
          i = j;
          continue;
        }
      }
    }

    result.push(line);
    i++;
  }

  return result.join('\n');
}

/**
 * Convert markdown to HTML using marked
 */
export function convertMarkdownToHtml(markdown) {
  // Pre-process: Handle Notion toggle lists before marked processing
  let processed = processToggleLists(markdown);

  // Pre-process: Convert multiple consecutive blank lines into empty paragraph markers
  // This preserves intentional spacing in the document
  // Two or more blank lines = one empty paragraph for spacing
  processed = processed.replace(/\n{3,}/g, '\n\n<p></p>\n\n');

  let html = marked(processed, {
    breaks: true,
    gfm: true,
    // Preserve code formatting
    mangle: false,
    headerIds: false,
  });

  // Remove trailing newlines inside <code> blocks (marked adds them, causing empty lines)
  html = html.replace(/(<code[^>]*>)([\s\S]*?)(<\/code>)/g, (match, open, content, close) => {
    return open + content.replace(/\n+$/, '') + close;
  });

  // Convert bash/shell code blocks to terminal blocks
  html = html.replace(
    /<pre><code class="language-(bash|shell|sh)">([\s\S]*?)<\/code><\/pre>/g,
    (match, lang, content) => {
      return `<div class="terminal-block"><div class="terminal-header"><div class="terminal-dots"><span></span><span></span><span></span></div><span class="terminal-title">Terminal</span></div><pre><code class="language-bash">${content}</code></pre></div>`;
    }
  );

  // Convert all other code blocks to styled code-block format with header and line numbers
  // This matches the editor's output format
  const langDisplayMap = {
    javascript: 'JavaScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    typescript: 'TypeScript',
    ts: 'TypeScript',
    tsx: 'TypeScript',
    python: 'Python',
    java: 'Java',
    html: 'HTML',
    css: 'CSS',
    json: 'JSON',
    sql: 'SQL',
    markdown: 'Markdown',
    yaml: 'YAML',
    go: 'Go',
    rust: 'Rust',
    php: 'PHP',
    ruby: 'Ruby',
    cpp: 'C++',
  };

  // Helper to escape HTML in code content
  const escapeHtml = text => {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  html = html.replace(
    /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
    (match, lang, content) => {
      // Decode HTML entities back to get actual content for line counting
      let decodedContent = content
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');

      // Remove trailing newlines to avoid extra empty line in line numbers
      decodedContent = decodedContent.replace(/\n+$/, '');
      const trimmedContent = content.replace(/\n+$/, '');

      const lines = decodedContent.split('\n');
      const lineNumbers = lines.map((_, i) => `<span class="line-number">${i + 1}</span>`).join('');
      const langDisplay = langDisplayMap[lang.toLowerCase()] || lang;

      return `<div class="code-block"><div class="code-header"><span class="code-lang">${langDisplay}</span></div><div class="code-body"><div class="line-numbers">${lineNumbers}</div><pre><code class="language-${lang}">${trimmedContent}</code></pre></div></div>`;
    }
  );

  // Also handle code blocks without a language class
  html = html.replace(
    /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
    (match, content) => {
      let decodedContent = content
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');

      // Remove trailing newlines to avoid extra empty line in line numbers
      decodedContent = decodedContent.replace(/\n+$/, '');
      const trimmedContent = content.replace(/\n+$/, '');

      const lines = decodedContent.split('\n');
      const lineNumbers = lines.map((_, i) => `<span class="line-number">${i + 1}</span>`).join('');

      return `<div class="code-block"><div class="code-header"><span class="code-lang">Code</span></div><div class="code-body"><div class="line-numbers">${lineNumbers}</div><pre><code>${trimmedContent}</code></pre></div></div>`;
    }
  );

  return html;
}

/**
 * Process emoji callouts in HTML
 * Converts lines starting with emoji + colon to <div class="callout">
 *
 * Pattern: Only converts paragraphs that follow the callout format:
 *   💡: This is a tip with enough content to be a callout
 *
 * Short definitions like "💻 : run in Terminal" are NOT converted to callouts
 * because they appear to be legend/key items, not actual callout blocks.
 *
 * Minimum content length: 30 characters after the emoji:colon prefix
 */
export function processEmojiCallouts(html) {
  // Common emoji patterns used in educational content
  // Must be followed by a colon (with optional space) to be treated as a callout
  const calloutPattern = /^(💻|🚀|❓|💡|⚠️|📝|✅|❌|🔥|📌|👉|🎯|📚|🛠️|🔔|⭐)\s*:\s*/;

  // Minimum content length after the emoji prefix for it to be a callout
  // Short items like "run in Terminal" are likely legends, not callouts
  const MIN_CALLOUT_CONTENT_LENGTH = 30;

  // Parse HTML and process paragraphs
  // IMPORTANT: Don't trim lines inside <pre>/<code> blocks as that destroys indentation
  const lines = html.split('\n');
  const processed = [];
  let inPreBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // Track whether we're inside a <pre> block to preserve indentation
    if (rawLine.includes('<pre>') || rawLine.includes('<pre ')) {
      inPreBlock = true;
    }

    // If inside a pre block, don't modify the line at all
    if (inPreBlock) {
      processed.push(rawLine);
      if (rawLine.includes('</pre>')) {
        inPreBlock = false;
      }
      continue;
    }

    const line = rawLine.trim();

    // Check if this is a paragraph starting with emoji + colon (callout format)
    if (line.startsWith('<p>')) {
      const content = line.slice(3, -4); // Remove <p> and </p>
      const match = content.match(calloutPattern);

      if (match) {
        const emoji = match[1];
        // Remove the emoji and colon prefix to get the text
        const text = content.replace(calloutPattern, '').trim();

        // Only convert to callout if the content is substantial
        // Short items like "run in Terminal" are likely legends/keys, not callouts
        if (text.length >= MIN_CALLOUT_CONTENT_LENGTH) {
          processed.push(
            `<div class="callout" style="align-items: flex-start;"><span class="callout-emoji">${emoji}</span><span>${text}</span></div>`
          );
          continue;
        }
      }
    }

    processed.push(line);
  }

  return processed.join('\n');
}

/**
 * Add background colors to h1/h2 headers for visual distinction
 * Colors match the editor's color picker palette
 */
export function addHeaderSpacing(html) {
  // h1: blue background (#DDEBF1), h2: yellow background (#FBF3DB)
  return html
    .replace(/<h1([^>]*)>/g, '<h1$1 style="background-color: #DDEBF1;">')
    .replace(/<h2([^>]*)>/g, '<h2$1 style="background-color: #FBF3DB;">');
}

/**
 * Rewrite image paths in HTML to point to GitHub raw URLs
 *
 * @param {string} html - HTML content with image tags
 * @param {Map} imageMap - Map of originalPath -> { newPath, githubUrl }
 * @returns {string} HTML with updated image paths
 */
export function rewriteImagePaths(html, imageMap) {
  let updatedHtml = html;

  imageMap.forEach((imageInfo, originalPath) => {
    // Get just the filename from the original path
    const filename = originalPath.split('/').pop();

    // Escape special regex characters for regex matching
    const escapeRegex = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedFilename = escapeRegex(filename);

    // Match both the full path and just the filename
    // This handles cases like: Short%201/image.png, Short 1/image.png, or just image.png
    const patterns = [
      // Match the exact original path (decoded)
      `src=["']${escapeRegex(originalPath)}["']`,
      // Match the exact original path (encoded)
      `src=["']${escapeRegex(originalPath.replace(/ /g, '%20'))}["']`,
      // Match any path ending with this filename
      `src=["'][^"']*/${escapedFilename}["']`,
      // Match just the filename
      `src=["']${escapedFilename}["']`,
    ];

    let matched = false;
    for (const pattern of patterns) {
      const regex = new RegExp(pattern, 'gi');
      const beforeReplace = updatedHtml;
      updatedHtml = updatedHtml.replace(regex, `src="${imageInfo.githubUrl}"`);

      if (beforeReplace !== updatedHtml) {
        matched = true;
        break;
      }
    }
  });

  return updatedHtml;
}

/**
 * Main import function - processes markdown and images
 *
 * @param {string} markdown - Raw markdown content
 * @param {Array} uploadedImages - Array of uploaded image files
 * @param {Object} options - { org, repo, contentPath, assetsFolder }
 * @returns {Object} { html, imageMap, unmatchedImages, missingImages }
 */
export async function processMarkdownImport(markdown, uploadedImages, options) {
  // 0. Normalize markdown from different sources (Obsidian, etc.)
  let normalizedMarkdown = normalizeMarkdown(markdown);

  // 0.5. Format code blocks with Prettier
  try {
    normalizedMarkdown = await formatCodeBlocks(normalizedMarkdown);
  } catch {
    // If formatting fails entirely, continue with original
  }

  // 1. Convert markdown to HTML
  let html = convertMarkdownToHtml(normalizedMarkdown);

  // 2. Remove the first H1 (it will be used as the page title)
  html = html.replace(/<h1[^>]*>.*?<\/h1>/i, '');

  // 3. Add spacing above headers
  html = addHeaderSpacing(html);

  // 4. Process emoji callouts
  html = processEmojiCallouts(html);

  // 5. Match images (use normalized markdown for proper path matching)
  const imageMap = matchImageReferences(normalizedMarkdown, uploadedImages);
  const references = extractImageReferences(normalizedMarkdown);

  // 6. Build GitHub URLs for matched images
  const imageMapWithUrls = new Map();
  imageMap.forEach((file, originalPath) => {
    // Generate sanitized filename with timestamp
    const timestamp = Date.now();
    const sanitizedName = file.name
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '-')
      .replace(/-+/g, '-');

    const newFilename = `${sanitizedName.split('.')[0]}-${timestamp}.${sanitizedName.split('.').pop()}`;
    const newPath = `${options.assetsFolder}/${newFilename}`;
    const githubUrl = `https://raw.githubusercontent.com/${options.org}/${options.repo}/main/${options.contentPath}/assets/${newFilename}`;

    imageMapWithUrls.set(originalPath, {
      file,
      newPath,
      newFilename,
      githubUrl,
    });
  });

  // 7. Rewrite image paths
  html = rewriteImagePaths(html, imageMapWithUrls);

  // 8. Find unmatched and missing images
  const matchedFilenames = new Set(Array.from(imageMap.values()).map(f => f.name.toLowerCase()));
  const unmatchedImages = uploadedImages.filter(f => !matchedFilenames.has(f.name.toLowerCase()));

  const referencedPaths = new Set(references.map(r => r.path.split('/').pop().toLowerCase()));
  const uploadedFilenames = new Set(uploadedImages.map(f => f.name.toLowerCase()));
  const missingImages = Array.from(referencedPaths).filter(path => !uploadedFilenames.has(path));

  return {
    html,
    imageMap: imageMapWithUrls,
    unmatchedImages,
    missingImages,
  };
}
