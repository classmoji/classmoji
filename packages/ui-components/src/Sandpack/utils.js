/**
 * Sandpack utility functions for parsing and serializing HTML markup
 *
 * HTML Format:
 * <div class="sandpack-embed"
 *      data-template="vanilla"
 *      data-theme="auto"
 *      data-layout="preview-right">
 *   <script type="application/json" data-sandpack-files>
 *     { "/index.html": "...", "/styles.css": "..." }
 *   </script>
 * </div>
 */

import { DEFAULT_FILES } from './constants.js';

/**
 * Parse Sandpack configuration from an HTML element
 *
 * @param {HTMLElement} element - The .sandpack-embed container element
 * @returns {{ template: string, theme: string, layout: string, files: Record<string, string>, options: object }}
 */
export function parseFromHtml(element) {
  const template = element.dataset.template || 'vanilla';
  const theme = element.dataset.theme || 'auto';
  const layout = element.dataset.layout || 'preview-right';

  // Parse editor width percentage (default 50%)
  const editorWidthPercentage = element.dataset.editorWidth
    ? parseInt(element.dataset.editorWidth, 10)
    : 50;

  // Parse additional options
  const options = {
    showTabs: element.dataset.showTabs !== 'false',
    showLineNumbers: element.dataset.showLineNumbers !== 'false',
    showConsole: element.dataset.showConsole === 'true',
    readOnly: element.dataset.readOnly === 'true',
    visibleFiles: null, // Will be set below if present
  };

  // Parse visibleFiles if present (stored as JSON array)
  if (element.dataset.visibleFiles) {
    try {
      options.visibleFiles = JSON.parse(element.dataset.visibleFiles);
    } catch (e) {
      console.warn('Failed to parse visibleFiles:', e);
    }
  }

  // Parse files from JSON script tag
  let files = {};
  const scriptEl = element.querySelector('script[data-sandpack-files]');
  if (scriptEl && scriptEl.textContent) {
    try {
      files = JSON.parse(scriptEl.textContent);
    } catch (e) {
      console.warn('Failed to parse Sandpack files JSON:', e);
    }
  }

  // If no files found, use defaults for the template
  if (Object.keys(files).length === 0) {
    files = DEFAULT_FILES[template] || DEFAULT_FILES.vanilla;
  }

  return { template, theme, layout, files, options, editorWidthPercentage };
}

/**
 * Serialize Sandpack configuration to HTML markup
 *
 * @param {{ template?: string, theme?: string, layout?: string, files: Record<string, string>, options?: object }} config
 * @returns {string} HTML string
 */
export function serializeToHtml(config) {
  const {
    template = 'vanilla',
    theme = 'auto',
    layout = 'preview-right',
    files = {},
    options = {},
  } = config;

  // Build data attributes
  const attrs = [`data-template="${template}"`, `data-theme="${theme}"`, `data-layout="${layout}"`];

  // Add optional attributes
  if (options.showTabs === false) attrs.push('data-show-tabs="false"');
  if (options.showLineNumbers === false) attrs.push('data-show-line-numbers="false"');
  if (options.showConsole === true) attrs.push('data-show-console="true"');
  if (options.readOnly === true) attrs.push('data-read-only="true"');
  if (options.visibleFiles && Array.isArray(options.visibleFiles) && options.visibleFiles.length > 0) {
    attrs.push(`data-visible-files='${JSON.stringify(options.visibleFiles)}'`);
  }

  // Add editor width if not default (50%)
  if (config.editorWidthPercentage && config.editorWidthPercentage !== 50) {
    attrs.push(`data-editor-width="${config.editorWidthPercentage}"`);
  }

  // Serialize files to JSON
  const filesJson = JSON.stringify(files, null, 2);

  return `<div class="sandpack-embed" ${attrs.join(' ')}>
  <script type="application/json" data-sandpack-files>
${filesJson}
  </script>
</div>`;
}

/**
 * Create a new Sandpack element with default configuration
 *
 * @param {string} template - Template name (vanilla, react, etc.)
 * @returns {HTMLElement} The created element
 */
export function createSandpackElement(template = 'vanilla') {
  const div = document.createElement('div');
  div.className = 'sandpack-embed';
  div.dataset.template = template;
  div.dataset.theme = 'auto';
  div.dataset.layout = 'preview-right';

  const files = DEFAULT_FILES[template] || DEFAULT_FILES.vanilla;
  const script = document.createElement('script');
  script.type = 'application/json';
  script.setAttribute('data-sandpack-files', '');
  script.textContent = JSON.stringify(files, null, 2);
  div.appendChild(script);

  return div;
}

/**
 * Update files in an existing Sandpack element
 *
 * @param {HTMLElement} element - The .sandpack-embed container element
 * @param {Record<string, string>} files - The new files object
 */
export function updateFilesInElement(element, files) {
  let scriptEl = element.querySelector('script[data-sandpack-files]');
  if (!scriptEl) {
    scriptEl = document.createElement('script');
    scriptEl.type = 'application/json';
    scriptEl.setAttribute('data-sandpack-files', '');
    element.appendChild(scriptEl);
  }
  scriptEl.textContent = JSON.stringify(files, null, 2);
}
