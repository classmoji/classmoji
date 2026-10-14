/**
 * SandpackEmbed - Standalone Sandpack component
 *
 * A configurable interactive code playground using CodeSandbox's Sandpack.
 * Can be used directly as a React component or mounted by SandpackRenderer
 * into innerHTML-based contexts.
 *
 * The slides mount it with files, options and a theme only. The quiz's code
 * sandboxes also pass children (hooks that read the running sandbox), an
 * explicit active file and init mode, a read-only flag, a preview that is
 * mounted only on request and no Run pill; every one of those props defaults
 * to what the slides have always got.
 */

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
  useSandpack,
} from '@codesandbox/sandpack-react';
import type {
  SandpackFile,
  SandpackInitMode,
  SandpackThemeProp,
  SandpackPredefinedTemplate,
} from '@codesandbox/sandpack-react';
import {
  githubLight,
  nightOwl,
  aquaBlue,
  sandpackDark,
  atomDark,
  monokaiPro,
} from '@codesandbox/sandpack-themes';
import { DEFAULT_FILES } from './constants.ts';
import { SandpackEditTracker } from './utils.ts';
import CollapsibleConsole from './CollapsibleConsole.tsx';

/**
 * Map of theme names to imported theme objects.
 * 'light' and 'dark' are built-in Sandpack themes (strings work).
 * All others must be imported from @codesandbox/sandpack-themes.
 */
const THEME_MAP: Record<string, SandpackThemeProp> = {
  light: 'light',
  dark: 'dark',
  githubLight,
  nightOwl,
  aquaBlue,
  sandpackDark,
  atomDark,
  monokaiPro,
};

interface FileSyncListenerProps {
  onFilesChange: (files: Record<string, string>, baseline: Record<string, string>) => void;
  /** The files handed to SandpackProvider (identity changes when Sandpack resets to them). */
  sourceFiles: Record<string, unknown>;
}

/**
 * Internal component that syncs file edits back to the callback
 *
 * Note: Sandpack's listen() is for bundler messages (compile status, errors),
 * NOT for file content changes. File edits are managed in React state, so we
 * watch sandpack.files directly which triggers re-renders on change.
 *
 * The map Sandpack reports on mount (or after resetting to new files) is not
 * an edit: it becomes the baseline and is never reported. Later maps are
 * reported with that baseline, so the write-back can tell a user's edit from
 * a template default (see SandpackEditTracker / syncEditedFiles).
 */
function FileSyncListener({ onFilesChange, sourceFiles }: FileSyncListenerProps) {
  const { sandpack } = useSandpack();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFilesRef = useRef<string | null>(null);
  const trackerRef = useRef<SandpackEditTracker | null>(null);

  useEffect(() => {
    if (!onFilesChange) return;
    if (!sandpack || !sandpack.files) return;

    // Extract current file contents
    const currentFiles: Record<string, string> = {};
    for (const [path, file] of Object.entries(sandpack.files)) {
      currentFiles[path] = file.code;
    }
    const currentJson = JSON.stringify(currentFiles);

    trackerRef.current ??= new SandpackEditTracker();
    const baseline = trackerRef.current.observe(sourceFiles, currentFiles);
    if (!baseline) {
      // Mount/reset report (or a stale one): never written back. A pending
      // edit from before the reset belongs to files Sandpack no longer shows.
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      lastFilesRef.current = currentJson;
      return;
    }

    // Compare with last known state to avoid unnecessary syncs
    if (lastFilesRef.current === currentJson) {
      return; // No change
    }
    lastFilesRef.current = currentJson;

    // Debounce the sync. The timer is not cleared when this effect merely
    // re-runs (other Sandpack state changes) — that would drop the edit.
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      onFilesChange(currentFiles, baseline);
    }, 300);
  }, [sandpack, sandpack?.files, onFilesChange, sourceFiles]);

  // Unmount: drop a pending sync.
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    []
  );

  return null;
}

export interface SandpackEmbedOptions {
  showTabs?: boolean;
  showLineNumbers?: boolean;
  showConsole?: boolean;
  readOnly?: boolean;
  visibleFiles?: string[] | null;
}

/**
 * A file handed to Sandpack: its contents, or Sandpack's object form
 * (`{ code, hidden, readOnly, … }`) for a file the editor must not show, such
 * as a support file the template needs.
 */
export type SandpackEmbedFile = string | SandpackFile;

/** The console under the layout (`options.showConsole`). */
export interface SandpackEmbedConsoleProps {
  /** Opens expanded. Default false. */
  defaultExpanded?: boolean;
  /** Its height when expanded, in pixels. Default 150. */
  maxHeight?: number;
  /** Clears its lines when the preview restarts. Default true. */
  resetOnPreviewRestart?: boolean;
}

export interface SandpackEmbedProps {
  template?: string;
  theme?: string;
  layout?: string;
  /**
   * The files. Sandpack resets its own file state (edits included) whenever
   * this object's identity changes, so a caller that keeps edits across
   * renders memoizes it.
   */
  files?: Record<string, SandpackEmbedFile>;
  options?: SandpackEmbedOptions;
  onFilesChange?: (files: Record<string, string>, baseline: Record<string, string>) => void;
  slideTheme?: string;
  className?: string;
  editorWidthPercentage?: number;
  /** Rendered inside the SandpackProvider, below the layout: hooks there can read Sandpack. */
  children?: ReactNode;
  /**
   * When Sandpack starts its bundler (Sandpack's own default when absent:
   * `lazy`). Read once, at mount: changing it later rebuilds the client.
   */
  initMode?: SandpackInitMode;
  /**
   * When the code editor builds its CodeMirror view (default: `initMode`).
   * In `lazy` the editor waits for an IntersectionObserver on its wrapper,
   * which a read-only editor (a static `<pre>`) never renders, so an editor
   * that mounts read-only and is unlocked later stays static. An editor that
   * can change from read-only to editable needs `immediate`.
   */
  editorInitMode?: SandpackInitMode;
  /** The file the editor opens on. Default: the first visible file, else the first file. */
  activeFile?: string;
  /**
   * Whether the preview is mounted. Default true (subject to `layout`).
   * Without a mounted preview no bundler runs; `previewPlaceholder` takes
   * its place.
   */
  showPreview?: boolean;
  /** Rendered in the preview's place while `showPreview` is false. */
  previewPlaceholder?: ReactNode;
  /** Read-only editor. Default: `options.readOnly`. */
  readOnly?: boolean;
  /** The layout's height (editor and preview). Default: the layout fills the wrapper. */
  height?: CSSProperties['height'];
  /** The console's own settings, when `options.showConsole` is on. */
  consoleProps?: SandpackEmbedConsoleProps;
  /**
   * Sandpack's own Run pill in the editor, shown while its bundler is idle.
   * Default true. A caller that starts the bundler itself turns it off.
   */
  showRunButton?: boolean;
}

/**
 * SandpackEmbed component
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
  children,
  initMode,
  editorInitMode,
  activeFile,
  showPreview: previewWanted = true,
  previewPlaceholder = null,
  readOnly: readOnlyProp,
  height,
  consoleProps,
  showRunButton = true,
}: SandpackEmbedProps) {
  const {
    showTabs = true,
    showLineNumbers = true,
    showConsole = false,
    readOnly: readOnlyOption = false,
    visibleFiles = null, // null means show all files
  } = options;
  const readOnly = readOnlyProp ?? readOnlyOption;

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
    const formatted: Record<string, SandpackFile> = {};
    for (const [path, content] of Object.entries(sourceFiles)) {
      // Object-form entries ({ code, hidden, active, … }) go to Sandpack as-is.
      formatted[path] = typeof content === 'string' ? { code: content } : content;
    }
    return formatted;
  }, [files, template]);

  // Determine layout direction
  const isVertical = layout === 'preview-bottom';
  const showEditor = layout !== 'preview-only';
  const hasPreview = layout !== 'editor-only';
  const showPreview = hasPreview && previewWanted;
  const paneStyle = (basis: string): CSSProperties => ({
    flex: 1,
    minHeight: 0, // Allow flex shrinking
    flexBasis: basis,
    minWidth: 0, // Allow shrinking below content size
  });
  const previewBasis = isVertical ? '100%' : `${100 - editorWidthPercentage}%`;

  return (
    <div className={`sandpack-embed-wrapper ${className}`}>
      <SandpackProvider
        template={template as SandpackPredefinedTemplate}
        theme={resolvedTheme}
        files={sandpackFiles}
        options={{
          activeFile: activeFile || visibleFiles?.[0] || Object.keys(sandpackFiles)[0],
          visibleFiles: visibleFiles || undefined, // undefined = show all files
          recompileMode: 'delayed',
          recompileDelay: 500,
          ...(initMode ? { initMode } : {}),
        }}
      >
        <SandpackLayout
          style={{
            flexDirection: isVertical ? 'column' : 'row',
            flexWrap: 'nowrap',
            ...(height !== undefined ? { height } : {}),
          }}
        >
          {showEditor && (
            <SandpackCodeEditor
              showTabs={showTabs}
              showLineNumbers={showLineNumbers}
              showInlineErrors
              showRunButton={showRunButton}
              wrapContent
              closableTabs={false}
              readOnly={readOnly}
              {...(editorInitMode ? { initMode: editorInitMode } : {})}
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
              style={paneStyle(previewBasis)}
            />
          )}
          {hasPreview && !showPreview && previewPlaceholder && (
            <div className="sandpack-embed-preview-placeholder" style={paneStyle(previewBasis)}>
              {previewPlaceholder}
            </div>
          )}
        </SandpackLayout>
        {showConsole && (
          <CollapsibleConsole
            maxHeight={consoleProps?.maxHeight ?? 150}
            defaultExpanded={consoleProps?.defaultExpanded ?? false}
            resetOnPreviewRestart={consoleProps?.resetOnPreviewRestart ?? true}
          />
        )}
        {onFilesChange && (
          <FileSyncListener onFilesChange={onFilesChange} sourceFiles={sandpackFiles} />
        )}
        {children}
      </SandpackProvider>
    </div>
  );
}
