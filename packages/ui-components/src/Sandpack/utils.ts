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

import { DEFAULT_FILES } from './constants.ts';

export interface SandpackOptions {
  showTabs: boolean;
  showLineNumbers: boolean;
  showConsole: boolean;
  readOnly: boolean;
  visibleFiles: string[] | null;
}

export interface SandpackConfig {
  template: string;
  theme: string;
  layout: string;
  files: Record<string, string>;
  options: SandpackOptions;
  editorWidthPercentage: number;
}

/**
 * Parse Sandpack configuration from an HTML element
 *
 * @param element - The .sandpack-embed container element
 */
export function parseFromHtml(element: HTMLElement): SandpackConfig {
  const template = element.dataset.template || 'vanilla';
  const theme = element.dataset.theme || 'auto';
  const layout = element.dataset.layout || 'preview-right';

  // Parse editor width percentage (default 50%)
  const editorWidthPercentage = element.dataset.editorWidth
    ? parseInt(element.dataset.editorWidth, 10)
    : 50;

  // Parse additional options
  const options: SandpackOptions = {
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

export interface SerializeConfig {
  template?: string;
  theme?: string;
  layout?: string;
  files?: Record<string, string>;
  options?: Partial<SandpackOptions>;
  editorWidthPercentage?: number;
}

/**
 * Serialize Sandpack configuration to HTML markup
 *
 * @param config - Sandpack configuration
 * @returns HTML string
 */
export function serializeToHtml(config: SerializeConfig): string {
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
  if (
    options.visibleFiles &&
    Array.isArray(options.visibleFiles) &&
    options.visibleFiles.length > 0
  ) {
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
 * @param template - Template name (vanilla, react, etc.)
 * @returns The created element
 */
export function createSandpackElement(template: string = 'vanilla'): HTMLElement {
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
 * @param element - The .sandpack-embed container element
 * @param files - The new files object
 */
export function updateFilesInElement(element: HTMLElement, files: Record<string, unknown>): void {
  let scriptEl = element.querySelector('script[data-sandpack-files]') as HTMLScriptElement | null;
  if (!scriptEl) {
    scriptEl = document.createElement('script');
    scriptEl.type = 'application/json';
    scriptEl.setAttribute('data-sandpack-files', '');
    element.appendChild(scriptEl);
  }
  scriptEl.textContent = JSON.stringify(files, null, 2);
}

/** A stored file entry: plain contents, or Sandpack's object form `{ code, hidden?, active?, … }`. */
type StoredFile = string | { code?: unknown; [key: string]: unknown };

function codeOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (
    entry &&
    typeof entry === 'object' &&
    typeof (entry as { code?: unknown }).code === 'string'
  ) {
    return (entry as { code: string }).code;
  }
  return undefined;
}

/** Sandpack's own path normalization: a leading slash. */
function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** Stable JSON form of a package.json, ignoring formatting, key order and empty dependency maps. */
function canonicalPackageJson(code: string): string | null {
  try {
    const parsed = JSON.parse(code);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    for (const key of ['dependencies', 'devDependencies']) {
      const value = parsed[key];
      if (value && typeof value === 'object' && Object.keys(value).length === 0) delete parsed[key];
    }
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.keys(value as object)
            .sort()
            .map(key => [key, sortKeys((value as Record<string, unknown>)[key])])
        );
      }
      return value;
    };
    return JSON.stringify(sortKeys(parsed));
  } catch {
    return null;
  }
}

function sameCode(path: string, stored: string, current: string): boolean {
  if (stored === current) return true;
  // Sandpack re-serializes /package.json on load (2-space indent, adds empty
  // dependency maps), so a byte compare would read every block as edited.
  if (normalizePath(path) === '/package.json') {
    const a = canonicalPackageJson(stored);
    return a !== null && a === canonicalPackageJson(current);
  }
  return false;
}

/**
 * Apply the editor's current file contents onto a block's STORED files.
 *
 * Sandpack's live file map is the template's files with the block's files on
 * top (plus a generated /package.json), so writing it back verbatim injects
 * template defaults (/styles.css, /package.json, …) into every block. Instead
 * only paths the block already stores are considered, each looked up by
 * Sandpack's normalized path and written back under its stored key, keeping
 * the object form and its other keys. Files the block doesn't store are
 * dropped: the editor offers no way to add one, so they can only be template
 * defaults.
 *
 * @returns the updated map, or null when nothing changed (no write needed).
 */
export function mergeEditedFiles(
  stored: Record<string, StoredFile>,
  current: Record<string, string>
): Record<string, StoredFile> | null {
  const currentByPath = new Map<string, string>();
  for (const [path, code] of Object.entries(current)) currentByPath.set(normalizePath(path), code);

  let changed = false;
  const merged: Record<string, StoredFile> = {};
  for (const [path, entry] of Object.entries(stored)) {
    const storedCode = codeOf(entry);
    const currentCode = currentByPath.get(normalizePath(path));
    if (
      storedCode === undefined ||
      currentCode === undefined ||
      sameCode(path, storedCode, currentCode)
    ) {
      merged[path] = entry;
      continue;
    }
    changed = true;
    merged[path] = typeof entry === 'string' ? currentCode : { ...entry, code: currentCode };
  }
  return changed ? merged : null;
}

/**
 * Write the editor's current files back into an embed's files script — only
 * the edits, onto what the element stores now (see mergeEditedFiles).
 *
 * @returns true when the element was written (the deck changed).
 */
export function syncEditedFiles(element: HTMLElement, current: Record<string, string>): boolean {
  let stored: Record<string, StoredFile> = {};
  const scriptEl = element.querySelector('script[data-sandpack-files]');
  if (scriptEl?.textContent) {
    try {
      const parsed = JSON.parse(scriptEl.textContent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
    } catch {
      // Unreadable payload: treated as empty, like parseFromHtml.
    }
  }
  // An empty block renders the template's starter files (parseFromHtml), so
  // those are what an edit lands on.
  if (Object.keys(stored).length === 0) {
    const template = element.dataset.template || 'vanilla';
    stored = DEFAULT_FILES[template] || DEFAULT_FILES.vanilla;
  }

  const merged = mergeEditedFiles(stored, current);
  if (!merged) return false;
  updateFilesInElement(element, merged);
  return true;
}
