// Re-export from @classmoji/services for backward compatibility
import { MarkdownImporter } from '@classmoji/services';

export const {
  normalizeMarkdown,
  extractTitleFromMarkdown,
  extractImageReferences,
  matchImageReferences,
  processToggleLists,
  convertMarkdownToHtml,
  processEmojiCallouts,
  addHeaderSpacing,
  rewriteImagePaths,
  processMarkdownImport,
} = MarkdownImporter;
