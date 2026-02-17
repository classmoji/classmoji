/**
 * Sandpack module exports
 *
 * Provides interactive code playground components for presentations and course content.
 */

// Import styles for custom components
import './styles.css';

export { default as SandpackEmbed } from './SandpackEmbed.jsx';
export { default as SandpackRenderer } from './SandpackRenderer.jsx';
export { default as SandpackBlock } from './SandpackBlock.jsx';
export { default as CollapsibleConsole } from './CollapsibleConsole.jsx';
export { default as useSandpackSync } from './useSandpackSync.js';
export { parseFromHtml, serializeToHtml, updateFilesInElement, createSandpackElement } from './utils.js';
export {
  SANDPACK_TEMPLATES,
  SANDPACK_THEMES,
  SANDPACK_LAYOUTS,
  DEFAULT_FILES,
} from './constants.js';
