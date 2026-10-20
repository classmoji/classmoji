// Shared contracts for Ask Moji run as a chat agent (`@classmoji/utils/ask-moji`).
// No server imports and no model-facing text: this module reaches the client bundle.
export * from './tools.ts';
export * from './uiTypes.ts';
export * from './visibility.ts';
export * from './copy.ts';
export * from './refusals.ts';
export * from './limits.ts';
export * from './metadata.ts';
export * from './runtime.ts';
// The generic projection (`projectMessage`, `projectTranscript`, …) is not
// re-exported: Ask Moji reads go through `projectAskMojiTranscript`, which adds
// the metadata allow-list. Import `@classmoji/utils/agents/projection` directly.
