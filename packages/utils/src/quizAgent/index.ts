// Shared contracts for quiz attempts run as chat agents (`@classmoji/utils/quiz-agent`).
// No server imports: this module reaches the client bundle.
export * from './grading.ts';
export * from './schemas.ts';
export * from './records.ts';
export * from './tools.ts';
export * from './uiTypes.ts';
export * from './visibility.ts';
export * from './status.ts';
export {
  createChunkProjector,
  projectMessage,
  projectTranscript,
  toolVisibility,
  type DataPartSchema,
  type Registry,
  type ToolVisibility,
} from '../agents/projection.ts';
export {
  ALLOWED_MODELS,
  FALLBACK_MODEL,
  THINKING,
  isAllowedModel,
  resolveAllowedModel,
  type AllowedModel,
  type ResolvedModel,
} from '../aiModels.ts';
