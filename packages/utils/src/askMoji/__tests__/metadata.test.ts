/**
 * Ask Moji's metadata allow-list (R8) and the part helpers the server reads:
 * what a viewer receives of a stored row or a live chunk, the cites persist
 * extracts, and the retention stubs.
 */
import { describe, expect, it } from 'vitest';
import {
  ASK_MOJI_AVAILABILITY_COPY,
  ASK_MOJI_COPY,
  ASK_MOJI_INSIGHT_DEFAULT_WEEKS,
  ASK_MOJI_PROJECTED_METADATA_KEYS,
  INSIGHT_MAX_WEEKS,
  AskMojiMessageMetadataSchema,
  AskMojiStepDataSchema,
  AskMojiUsageSchema,
  INSIGHT_MIN_ASKERS,
  IN_FLIGHT_STALE_MS,
  INSTRUCTIONS_MAX_CHARS,
  MAX_SLIDE_INDEX,
  TOOL_OUTPUT_STUB,
  TURN_DEADLINE_MS,
  citesFromParts,
  createAskMojiChunkProjector,
  filterAskMojiChunkMetadata,
  isLookupPart,
  isRateableRow,
  projectAskMojiMetadata,
  projectAskMojiTranscript,
  stubLookupOutputs,
  withRateable,
  type AskMojiUIMessage,
} from '../index.ts';

const serverOnlyUser = {
  viewing: { kind: 'deck', id: 'd1', slide: 3 },
  acting_role: 'TEACHER',
  resolved_viewing: { kind: 'deck', id: 'd1' },
  settled: { outcome: 'final', at: '2026-10-18T00:00:00.000Z' },
};

const serverOnlyAssistant = {
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    calls: 1,
    model: 'm',
  },
  model: 'm',
  cites: [{ type: 'page', id: 'p1', title: 'Syllabus' }],
};

describe('projectAskMojiMetadata', () => {
  it('keeps only the client viewing on user rows', () => {
    expect(projectAskMojiMetadata('user', serverOnlyUser)).toEqual({
      viewing: { kind: 'deck', id: 'd1', slide: 3 },
    });
    expect(projectAskMojiMetadata('user', { acting_role: 'OWNER' })).toBeUndefined();
    expect(projectAskMojiMetadata('user', { viewing: { kind: 'repo' } })).toBeUndefined();
    expect(projectAskMojiMetadata('user', null)).toBeUndefined();
  });

  it('keeps only a boolean rateable on assistant rows', () => {
    expect(projectAskMojiMetadata('assistant', serverOnlyAssistant)).toBeUndefined();
    expect(projectAskMojiMetadata('assistant', { viewing: { kind: 'page' } })).toBeUndefined();
    expect(projectAskMojiMetadata('assistant', { ...serverOnlyAssistant, rateable: true })).toEqual(
      { rateable: true }
    );
    expect(projectAskMojiMetadata('assistant', { rateable: false })).toEqual({ rateable: false });
    expect(projectAskMojiMetadata('assistant', { rateable: 'yes' })).toBeUndefined();
    // rateable never passes on a user row.
    expect(projectAskMojiMetadata('user', { rateable: true })).toBeUndefined();
    expect(ASK_MOJI_PROJECTED_METADATA_KEYS.assistant).toEqual(['rateable']);
  });

  it('refuses rateable from a browser (admission schema)', () => {
    expect(AskMojiMessageMetadataSchema.safeParse({ rateable: true }).success).toBe(false);
  });
});

describe('rateable', () => {
  const row = (over: object) => ({
    role: 'ASSISTANT',
    final: true,
    provenance: 'model',
    metadata: null as unknown,
    ...over,
  });

  it('is a final assistant row written by the model', () => {
    expect(isRateableRow(row({}))).toBe(true);
    expect(isRateableRow(row({ final: false }))).toBe(false);
    expect(isRateableRow(row({ provenance: 'server' }))).toBe(false);
    expect(isRateableRow(row({ provenance: null }))).toBe(false);
    expect(isRateableRow(row({ role: 'USER' }))).toBe(false);
  });

  it('withRateable writes the decision over a stored value, on assistant rows only', () => {
    expect(withRateable(row({ metadata: { rateable: true }, final: false })).metadata).toEqual({
      rateable: false,
    });
    expect(withRateable(row({ metadata: serverOnlyAssistant })).metadata).toEqual({
      ...serverOnlyAssistant,
      rateable: true,
    });
    const user = row({ role: 'USER', metadata: { viewing: { kind: 'calendar' } } });
    expect(withRateable(user)).toBe(user);
  });
});

describe('projectAskMojiTranscript', () => {
  it('drops every server-only key and MCP part, and passes viewing', () => {
    const rows = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'Q' }],
        metadata: serverOnlyUser,
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'tool-get_roster', toolCallId: 't', state: 'output-available', output: 'Bo' },
          { type: 'text', text: 'A' },
        ],
        metadata: serverOnlyAssistant,
      },
    ] as unknown as AskMojiUIMessage[];
    const shown = projectAskMojiTranscript(rows);
    expect(shown[0].metadata).toEqual({ viewing: { kind: 'deck', id: 'd1', slide: 3 } });
    // No rateable decision on the stored row: no metadata at all.
    expect('metadata' in shown[1]).toBe(false);
    expect(shown[1].parts.map(p => p.type)).toEqual(['text']);
    const json = JSON.stringify(shown);
    for (const key of ['acting_role', 'resolved_viewing', 'settled', 'usage', 'cites', 'Bo']) {
      expect(json).not.toContain(key);
    }
  });

  it('passes the rateable decision on assistant rows and nothing else of theirs', () => {
    const rows = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Q' }], metadata: serverOnlyUser },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'A' }],
        metadata: { ...serverOnlyAssistant, rateable: true },
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'notice' }],
        metadata: { rateable: false },
      },
    ] as unknown as AskMojiUIMessage[];
    const shown = projectAskMojiTranscript(rows);
    expect(shown.map(m => m.metadata)).toEqual([
      { viewing: { kind: 'deck', id: 'd1', slide: 3 } },
      { rateable: true },
      { rateable: false },
    ]);
  });
});

describe('chunk metadata', () => {
  it('cuts messageMetadata from start and finish, and drops message-metadata', () => {
    expect(
      filterAskMojiChunkMetadata({
        type: 'start',
        messageId: 'a1',
        messageMetadata: serverOnlyAssistant,
      } as never)
    ).toEqual({ type: 'start', messageId: 'a1' });
    expect(
      filterAskMojiChunkMetadata({ type: 'finish', messageMetadata: serverOnlyAssistant } as never)
    ).toEqual({ type: 'finish' });
    expect(
      filterAskMojiChunkMetadata({
        type: 'message-metadata',
        messageMetadata: serverOnlyAssistant,
      } as never)
    ).toBeNull();
    const text = { type: 'text-delta', id: 't', delta: 'x' };
    expect(filterAskMojiChunkMetadata(text as never)).toBe(text);
  });

  it('never passes rateable on a live chunk (only the stored transcript decides it)', () => {
    expect(
      filterAskMojiChunkMetadata({
        type: 'finish',
        messageMetadata: { rateable: true },
      } as never)
    ).toEqual({ type: 'finish' });
  });

  it('the full projector applies the part rule and the metadata rule', () => {
    const project = createAskMojiChunkProjector();
    expect(project({ type: 'start', messageMetadata: { usage: 1 } } as never)).toEqual({
      type: 'start',
    });
    expect(project({ type: 'reasoning-delta', id: 'r', delta: 'x' } as never)).toBeNull();
    expect(
      project({ type: 'tool-input-start', toolCallId: 'c', toolName: 'my_grades' } as never)
    ).toBeNull();
    expect(
      project({
        type: 'data-step',
        id: 'c',
        data: { title: 'Looking up your grades', status: 'running' },
      } as never)
    ).toEqual({
      type: 'data-step',
      id: 'c',
      data: { title: 'Looking up your grades', status: 'running' },
    });
  });
});

describe('citesFromParts', () => {
  it('takes ok cite_content results only, deduplicated', () => {
    const cite = (output: unknown, input: unknown = { type: 'page', id: 'p1' }) => ({
      type: 'tool-cite_content',
      toolCallId: 'c',
      state: 'output-available',
      input,
      output,
    });
    expect(
      citesFromParts([
        cite({ ok: true, title: 'Syllabus', url: 'https://x' }),
        cite({ ok: true, title: 'Syllabus' }),
        cite({ ok: false }),
        cite({ ok: true, type: 'slides', id: 'd1', title: 'Week 1' }, { type: 'slides', id: 'd1' }),
        cite({ ok: true, title: 'Docs' }, { type: 'platform_docs', path: '/docs/x' }),
        { ...cite({ ok: true }), state: 'input-available' },
        { type: 'tool-content_get', state: 'output-available', output: { ok: true } },
        { type: 'text', text: 'x' },
      ])
    ).toEqual([
      { type: 'page', id: 'p1', title: 'Syllabus' },
      { type: 'slides', id: 'd1', title: 'Week 1' },
      { type: 'platform_docs', path: '/docs/x', title: 'Docs' },
    ]);
  });
});

describe('stubLookupOutputs', () => {
  it('stubs MCP outputs (string or object), keeps inputs, text, cites and data parts', () => {
    const parts = [
      { type: 'step-start' },
      {
        type: 'tool-content_get',
        toolCallId: 'a',
        state: 'output-available',
        input: { id: 'p' },
        output: 'page text',
      },
      {
        type: 'dynamic-tool',
        toolName: 'list_submissions',
        toolCallId: 'b',
        state: 'output-available',
        input: {},
        output: { rows: [1] },
      },
      {
        type: 'tool-cite_content',
        toolCallId: 'c',
        state: 'output-available',
        input: {},
        output: { ok: true },
      },
      { type: 'data-step', id: 'a', data: { title: 'Reading Syllabus', status: 'done' } },
      { type: 'text', text: 'answer' },
    ];
    const { parts: out, changed } = stubLookupOutputs(parts);
    expect(changed).toBe(true);
    expect(out[1]).toEqual({ ...parts[1], output: TOOL_OUTPUT_STUB });
    expect(out[2]).toEqual({ ...parts[2], output: TOOL_OUTPUT_STUB });
    expect(out[3]).toBe(parts[3]);
    expect(out[4]).toBe(parts[4]);
    expect(out[5]).toBe(parts[5]);
    expect(stubLookupOutputs(out).changed).toBe(false);
    expect(isLookupPart({ type: 'tool-cite_content' })).toBe(false);
    expect(isLookupPart({ type: 'text' })).toBe(false);
  });
});

describe('contract additions', () => {
  it('viewing carries a bounded slide index', () => {
    const ok = (v: unknown) => AskMojiMessageMetadataSchema.safeParse({ viewing: v }).success;
    expect(ok({ kind: 'deck', id: 'd', slide: 0 })).toBe(true);
    expect(ok({ kind: 'deck', id: 'd', slide: MAX_SLIDE_INDEX })).toBe(true);
    expect(ok({ kind: 'deck', id: 'd', slide: -1 })).toBe(false);
    expect(ok({ kind: 'deck', id: 'd', slide: 1.5 })).toBe(false);
    expect(ok({ kind: 'deck', id: 'd', slide: MAX_SLIDE_INDEX + 1 })).toBe(false);
  });

  it('step lines carry an optional status', () => {
    expect(AskMojiStepDataSchema.safeParse({ title: 'x', status: 'done' }).success).toBe(true);
    expect(AskMojiStepDataSchema.safeParse({ title: 'x' }).success).toBe(true);
    expect(AskMojiStepDataSchema.safeParse({ title: 'x', status: 'later' }).success).toBe(false);
  });

  it('states the new limits and lines', () => {
    expect(IN_FLIGHT_STALE_MS).toBeGreaterThan(TURN_DEADLINE_MS);
    expect(INSTRUCTIONS_MAX_CHARS).toBe(4_000);
    expect(INSIGHT_MIN_ASKERS).toBe(3);
    expect(ASK_MOJI_INSIGHT_DEFAULT_WEEKS).toBe(12);
    expect(ASK_MOJI_INSIGHT_DEFAULT_WEEKS).toBeLessThanOrEqual(INSIGHT_MAX_WEEKS);
    expect(ASK_MOJI_COPY.BUSY_ELSEWHERE).toBe('Ask Moji is answering in another window.');
    expect(Object.keys(ASK_MOJI_AVAILABILITY_COPY).sort()).toEqual(
      ['NOT_ENABLED', 'NO_API_KEY', 'PRO_REQUIRED', 'RUNTIME_OFF', 'TRIGGER_NOT_CONFIGURED'].sort()
    );
    expect(AskMojiUsageSchema.safeParse({ ...serverOnlyAssistant.usage, extra: 1 }).success).toBe(
      false
    );
  });
});
