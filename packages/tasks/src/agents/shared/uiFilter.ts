/**
 * The browser-facing stream adapter: applies an agent's allow-list projection
 * (packages/utils/src/agents/projection.ts) to the UI chunks piped to the
 * session's output. The same projection runs on every stored read, so a
 * refresh shows exactly what the live view showed.
 *
 * It must sit DOWNSTREAM of the callback that persists the full message: the
 * loop persists in `createUIMessageStream`'s `onEnd`, then pipes through this.
 */
import type { UIMessageChunk } from 'ai';
import { createChunkProjector, quizVisibility, type Registry } from '@classmoji/utils/quiz-agent';

/** A fresh, stateful projector per stream (it tracks tool call ids it has seen named). */
export function projectChunks(
  registry: Registry = quizVisibility as Registry
): TransformStream<UIMessageChunk, UIMessageChunk> {
  const project = createChunkProjector(registry);
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      const out = project(chunk);
      if (out) controller.enqueue(out);
    },
  });
}
