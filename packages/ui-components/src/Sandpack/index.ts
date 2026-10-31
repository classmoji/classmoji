/**
 * Sandpack module exports
 *
 * Provides interactive code playground components for presentations and course content.
 */

// Import styles for custom components
import './styles.css';

export { default as SandpackEmbed } from './SandpackEmbed.tsx';
export { default as SandpackRenderer } from './SandpackRenderer.tsx';
export { default as SandpackBlock } from './SandpackBlock.tsx';
export { default as CollapsibleConsole } from './CollapsibleConsole.tsx';
export { default as useSandpackSync } from './useSandpackSync.ts';
export { default as useSandboxCapture } from './useSandboxCapture.ts';
export type { SandboxCapture, UseSandboxCaptureOptions } from './useSandboxCapture.ts';
export type {
  SandpackEmbedConsoleProps,
  SandpackEmbedFile,
  SandpackEmbedOptions,
  SandpackEmbedProps,
} from './SandpackEmbed.tsx';
export {
  DEFAULT_CAPTURE_LIMITS,
  capturedErrorsOf,
  cleanErrorMessage,
  consoleLinesOf,
  filesAt,
  type CaptureLimits,
  type CapturedConsoleLine,
  type CapturedError,
} from './sandboxCapture.ts';
export {
  parseFromHtml,
  serializeToHtml,
  updateFilesInElement,
  mergeEditedFiles,
  syncEditedFiles,
  SandpackEditTracker,
  createSandpackElement,
  filesDiffer,
} from './utils.ts';
export {
  SANDPACK_TEMPLATES,
  SANDPACK_THEMES,
  SANDPACK_LAYOUTS,
  DEFAULT_FILES,
  SANDBOX_SUPPORT_FILES,
  type SandboxSupportFile,
} from './constants.ts';
