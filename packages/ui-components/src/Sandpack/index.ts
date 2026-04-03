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
export {
  parseFromHtml,
  serializeToHtml,
  updateFilesInElement,
  createSandpackElement,
} from './utils.ts';
export {
  SANDPACK_TEMPLATES,
  SANDPACK_THEMES,
  SANDPACK_LAYOUTS,
  DEFAULT_FILES,
} from './constants.ts';
