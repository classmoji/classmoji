/**
 * The quiz's metadata rules: viewers get only `action` (after the projection),
 * so a stored reply's `usage` never reaches one; raw-row readers drop `usage`
 * and keep every other key.
 */
import { describe, expect, it } from 'vitest';
import {
  QUIZ_SERVER_METADATA_KEYS,
  QUIZ_VIEWER_METADATA_KEYS,
  projectTranscript,
  quizStaffVisibility,
  quizVisibility,
  withViewerMetadata,
  withoutServerMetadataKeys,
  type QuizUIMessage,
} from '../index.ts';

const USAGE = {
  input: 81234,
  output: 512,
  cacheRead: 52000,
  cacheWrite: 29000,
  reasoning: 80,
  calls: 1,
  model: 'claude-sonnet-5-5',
  cacheTtl: '1h',
  steps: [
    {
      kind: 'answer',
      input: 81234,
      cacheRead: 52000,
      cacheWrite: 29000,
      output: 512,
      reasoning: 80,
      tools: ['record_question_result'],
    },
  ],
};

const transcript = [
  {
    id: 'u1',
    role: 'user',
    parts: [{ type: 'text', text: 'Next' }],
    metadata: { action: 'next' },
  },
  {
    id: 'a1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Here is question 2.' }],
    metadata: { usage: USAGE },
  },
] as unknown as QuizUIMessage[];

describe('quiz viewer metadata', () => {
  it('names action as the one viewer key and usage as server-only', () => {
    expect([...QUIZ_VIEWER_METADATA_KEYS]).toEqual(['action']);
    expect(QUIZ_SERVER_METADATA_KEYS).toContain('usage');
  });

  it('withViewerMetadata keeps only the viewer keys; none left, no metadata', () => {
    expect(
      withViewerMetadata({ id: 'u', metadata: { action: 'next', usage: USAGE, later: 1 } })
    ).toEqual({ id: 'u', metadata: { action: 'next' } });
    expect(withViewerMetadata({ id: 'a', metadata: { usage: USAGE, other: 1 } })).toEqual({
      id: 'a',
    });
    expect(withViewerMetadata({ id: 'n' } as { id: string; metadata?: unknown })).toEqual({
      id: 'n',
    });
  });

  it('withoutServerMetadataKeys drops usage, keeps every other key, null when nothing is left', () => {
    expect(withoutServerMetadataKeys({ usage: USAGE, explorationSteps: [1] })).toEqual({
      explorationSteps: [1],
    });
    expect(withoutServerMetadataKeys({ usage: USAGE })).toBeNull();
    const plain = { errorType: 'AGENT_FAILURE' };
    expect(withoutServerMetadataKeys(plain)).toBe(plain);
    expect(withoutServerMetadataKeys(null)).toBeNull();
  });

  it('a stored usage never reaches the student or the staff view; the action still does', () => {
    for (const registry of [quizVisibility, quizStaffVisibility]) {
      // What the projection alone would pass: the reason for the allow-list.
      expect(JSON.stringify(projectTranscript(transcript, registry))).toContain('cacheTtl');
      const viewed = projectTranscript(transcript, registry).map(withViewerMetadata);
      const json = JSON.stringify(viewed);
      expect(json).not.toContain('usage');
      expect(json).not.toContain('cacheTtl');
      expect(json).not.toContain('steps');
      expect(json).not.toContain('record_question_result');
      expect(viewed[0].metadata).toEqual({ action: 'next' });
      expect(viewed[1].metadata).toBeUndefined();
    }
  });
});
