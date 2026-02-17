/**
 * SandpackEmbed - Standalone Sandpack component
 *
 * A configurable interactive code playground using CodeSandbox's Sandpack.
 * Can be used directly as a React component or mounted by SandpackRenderer
 * into innerHTML-based contexts.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
  useSandpack,
} from '@codesandbox/sandpack-react';
import {
  githubLight,
  nightOwl,
  aquaBlue,
  sandpackDark,
  atomDark,
  monokaiPro,
} from '@codesandbox/sandpack-themes';
import { DEFAULT_FILES } from './constants.js';
import CollapsibleConsole from './CollapsibleConsole.jsx';

/**
 * Map of theme names to imported theme objects.
 * 'light' and 'dark' are built-in Sandpack themes (strings work).
 * All others must be imported from @codesandbox/sandpack-themes.
 */
const THEME_MAP = {
  light: 'light',
  dark: 'dark',
  githubLight,
  nightOwl,
  aquaBlue,
  sandpackDark,
  atomDark,
  monokaiPro,
};

/**
 * Internal component that syncs file changes back to the callback
 *
 * Note: Sandpack's listen() is for bundler messages (compile status, errors),
 * NOT for file content changes. File edits are managed in React state, so we
 * watch sandpack.files directly which triggers re-renders on change.
 */
function FileSyncListener({ onFilesChange }) {
  const { sandpack } = useSandpack();
  const timeoutRef = useRef(null);
  const lastFilesRef = useRef(null);

  useEffect(() => {
    if (!onFilesChange) return;
    if (!sandpack || !sandpack.files) return;

    // Extract current file contents
    const currentFiles = {};
    for (const [path, file] of Object.entries(sandpack.files)) {
      currentFiles[path] = file.code;
    }

    // Compare with last known state to avoid unnecessary syncs
    const currentJson = JSON.stringify(currentFiles);
    if (lastFilesRef.current === currentJson) {
      return; // No change
    }
    lastFilesRef.current = currentJson;

    // Debounce the sync
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      onFilesChange(currentFiles);
    }, 300);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [sandpack, sandpack?.files, onFilesChange]);

  return null;
}

/**
 * SandpackEmbed component
 *
 * @param {object} props
 * @param {string} [props.template='vanilla'] - Template: vanilla, react, vanilla-ts, react-ts
 * @param {string} [props.theme='auto'] - Theme name or 'auto' to match slide theme
 * @param {string} [props.layout='preview-right'] - Layout: preview-right, preview-bottom, preview-only, editor-only
 * @param {Record<string, string>} [props.files] - File contents keyed by path
 * @param {object} [props.options] - Additional Sandpack options
 * @param {boolean} [props.options.showTabs=true] - Show file tabs
 * @param {boolean} [props.options.showLineNumbers=true] - Show line numbers
 * @param {boolean} [props.options.showConsole=false] - Show console panel
 * @param {boolean} [props.options.readOnly=false] - Read-only mode
 * @param {string[]} [props.options.visibleFiles] - Array of file paths to show as tabs (e.g., ['/index.html']). If not set, all files are visible.
 * @param {function} [props.onFilesChange] - Callback when files change
 * @param {string} [props.slideTheme] - Current slide theme for auto theme detection
 * @param {string} [props.className] - Additional CSS classes
 */
export default function SandpackEmbed({
  template = 'vanilla',
  theme = 'auto',
  layout = 'preview-right',
  files,
  options = {},
  onFilesChange,
  slideTheme,
  className = '',
  editorWidthPercentage = 50,
}) {
  const {
    showTabs = true,
    showLineNumbers = true,
    showConsole = false,
    readOnly = false,
    visibleFiles = null, // null means show all files
  } = options;

  // Resolve theme - 'auto' picks based on slide theme
  // Returns a theme object from THEME_MAP (or string for 'light'/'dark')
  const resolvedTheme = useMemo(() => {
    if (theme === 'auto') {
      // Check if slide theme is dark
      const darkThemes = ['black', 'league', 'night', 'moon', 'dracula', 'blood'];
      const isDark = slideTheme && darkThemes.includes(slideTheme);
      return isDark ? 'dark' : 'light';
    }
    // Return the theme object from THEME_MAP, fallback to 'light' if not found
    return THEME_MAP[theme] || 'light';
  }, [theme, slideTheme]);

  // Prepare files for Sandpack
  const sandpackFiles = useMemo(() => {
    const sourceFiles =
      files && Object.keys(files).length > 0
        ? files
        : DEFAULT_FILES[template] || DEFAULT_FILES.vanilla;

    // Convert string values to Sandpack file format
    const formatted = {};
    for (const [path, content] of Object.entries(sourceFiles)) {
      formatted[path] = typeof content === 'string' ? { code: content } : content;
    }
    return formatted;
  }, [files, template]);

  // Determine layout direction
  const isVertical = layout === 'preview-bottom';
  const showEditor = layout !== 'preview-only';
  const showPreview = layout !== 'editor-only';

  return (
    <div
      className={`sandpack-embed-wrapper ${className}`}
    >
      <SandpackProvider
        template={template}
        theme={resolvedTheme}
        files={sandpackFiles}
        options={{
          activeFile: visibleFiles?.[0] || Object.keys(sandpackFiles)[0],
          visibleFiles: visibleFiles || undefined, // undefined = show all files
          recompileMode: 'delayed',
          recompileDelay: 500,
        }}
      >
        <SandpackLayout
          style={{
            flexDirection: isVertical ? 'column' : 'row',
            flexWrap: 'nowrap',
          }}
        >
          {showEditor && (
            <SandpackCodeEditor
              showTabs={showTabs}
              showLineNumbers={showLineNumbers}
              showInlineErrors
              wrapContent
              closableTabs={false}
              readOnly={readOnly}
              style={{
                flex: 1,
                minHeight: 0, // Allow flex shrinking
                flexBasis: isVertical ? '100%' : `${editorWidthPercentage}%`,
                minWidth: 0, // Allow shrinking below content size
              }}
            />
          )}
          {showPreview && (
            <SandpackPreview
              showOpenInCodeSandbox={false}
              showRefreshButton
              style={{
                flex: 1,
                minHeight: 0, // Allow flex shrinking
                flexBasis: isVertical ? '100%' : `${100 - editorWidthPercentage}%`,
                minWidth: 0, // Allow shrinking below content size
              }}
            />
          )}
        </SandpackLayout>
        {showConsole && <CollapsibleConsole maxHeight={150} />}
        {onFilesChange && <FileSyncListener onFilesChange={onFilesChange} />}
      </SandpackProvider>
    </div>
  );
}
