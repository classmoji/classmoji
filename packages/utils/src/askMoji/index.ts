// Shared contracts for Ask Moji run as a chat agent (`@classmoji/utils/ask-moji`).
// No server imports and no model-facing text: this module reaches the client bundle.
export * from './tools.ts';
export * from './uiTypes.ts';
export * from './visibility.ts';
export * from './copy.ts';
export * from './refusals.ts';
export * from './limits.ts';
export * from './metadata.ts';
export {
  createChunkProjector,
  projectMessage,
  projectTranscript,
  toolVisibility,
  type DataPartSchema,
  type Registry,
  type ToolVisibility,
} from '../agents/projection.ts';
