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
  MAX_USAGE_STEPS,
  MAX_USAGE_STEP_TOOLS,
  MAX_USAGE_TOOL_NAME_CHARS,
  TOOL_OUTPUT_STUB,
  TURN_DEADLINE_MS,
  citesFromParts,
  createAskMojiChunkProjector,
  filterAskMojiChunkMetadata,
  isLookupPart,
  isRateableRow,
  mergeUsage,
  projectAskMojiMetadata,
  projectAskMojiTranscript,
  stubLookupOutputs,
  withRateable,
  type AskMojiUIMessage,
  type AskMojiUsageStep,
} from '../index.ts';

const serverOnlyUser = {
  viewing: { kind: 'deck', id: 'd1', slide: 3 },
  acting_role: 'TEACHER',
  resolved_viewing: { kind: 'deck', id: 'd1' },
  settled: { outcome: 'final', at: '2026-10-18T00:00:00.000Z' },
  turn_note: 'SERVER NOTICE for the message above\nNOW: Monday 9:00 AM',
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
      ['NOT_ENABLED', 'NO_API_KEY', 'PRO_REQUIRED', 'TRIGGER_NOT_CONFIGURED'].sort()
    );
    expect(AskMojiUsageSchema.safeParse({ ...serverOnlyAssistant.usage, extra: 1 }).success).toBe(
      false
    );
  });
});

describe('usage: cache TTL and per-call steps', () => {
  const OLD_ROW = {
    input: 4500,
    output: 60,
    cacheRead: 90,
    cacheWrite: 30,
    reasoning: 15,
    calls: 3,
    model: 'claude-sonnet-5-5',
  };
  const step = (over: Partial<AskMojiUsageStep> = {}): AskMojiUsageStep => ({
    kind: 'answer',
    input: 30960,
    cacheRead: 0,
    cacheWrite: 30840,
    output: 140,
    reasoning: 40,
    tools: ['content_search'],
    ...over,
  });

  it('a row written before cacheTtl and steps still parses, unchanged', () => {
    const parsed = AskMojiUsageSchema.safeParse(OLD_ROW);
    expect(parsed.success && parsed.data).toEqual(OLD_ROW);
  });

  it('parses cacheTtl and steps', () => {
    const usage = {
      ...OLD_ROW,
      cacheTtl: '5m',
      steps: [step(), step({ kind: 'summary', tools: [] })],
    };
    expect(AskMojiUsageSchema.safeParse(usage).success).toBe(true);
    expect(AskMojiUsageSchema.safeParse({ ...OLD_ROW, cacheTtl: '1h' }).success).toBe(true);
  });

  it('refuses a bad TTL, too many steps, a long or empty tool name, too many tools, an extra key', () => {
    const bad = [
      { ...OLD_ROW, cacheTtl: '24h' },
      { ...OLD_ROW, steps: Array.from({ length: MAX_USAGE_STEPS + 1 }, () => step()) },
      { ...OLD_ROW, steps: [step({ tools: ['x'.repeat(MAX_USAGE_TOOL_NAME_CHARS + 1)] })] },
      { ...OLD_ROW, steps: [step({ tools: [''] })] },
      {
        ...OLD_ROW,
        steps: [step({ tools: Array.from({ length: MAX_USAGE_STEP_TOOLS + 1 }, () => 't') })],
      },
      { ...OLD_ROW, steps: [{ ...step(), input_text: 'what the student asked' }] },
      { ...OLD_ROW, steps: [step({ kind: 'other' as never })] },
      { ...OLD_ROW, steps: [step({ input: -1 })] },
    ];
    for (const usage of bad) expect(AskMojiUsageSchema.safeParse(usage).success).toBe(false);
    expect(
      AskMojiUsageSchema.safeParse({
        ...OLD_ROW,
        steps: Array.from({ length: MAX_USAGE_STEPS }, () => step()),
      }).success
    ).toBe(true);
  });

  it('mergeUsage sums every count, keeps the first model and TTL, appends steps up to the cap', () => {
    const reply = { ...OLD_ROW, cacheTtl: '5m' as const, steps: [step(), step()] };
    const summary = {
      input: 5000,
      output: 300,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 20,
      calls: 1,
      model: 'other-model',
      steps: [
        step({
          kind: 'summary',
          input: 5000,
          cacheWrite: 0,
          output: 300,
          reasoning: 20,
          tools: [],
        }),
      ],
    };
    const merged = mergeUsage(reply, summary);
    expect(merged).toEqual({
      input: 9500,
      output: 360,
      cacheRead: 90,
      cacheWrite: 30,
      reasoning: 35,
      calls: 4,
      model: 'claude-sonnet-5-5',
      cacheTtl: '5m',
      steps: [...reply.steps, ...summary.steps],
    });
    expect(AskMojiUsageSchema.safeParse(merged).success).toBe(true);

    const full = { ...reply, steps: Array.from({ length: MAX_USAGE_STEPS }, () => step()) };
    const capped = mergeUsage(full, summary);
    expect(capped.steps).toHaveLength(MAX_USAGE_STEPS);
    expect(capped.calls).toBe(4);
    expect(AskMojiUsageSchema.safeParse(capped).success).toBe(true);
  });

  it('mergeUsage of two old rows keeps the old shape (no steps, no TTL keys)', () => {
    const merged = mergeUsage(OLD_ROW, { ...OLD_ROW, model: null });
    expect(Object.keys(merged).sort()).toEqual(Object.keys(OLD_ROW).sort());
    expect(merged.calls).toBe(6);
  });

  it('usage stays a server-only key', () => {
    const projected = projectAskMojiTranscript([
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hi' }],
        metadata: { usage: { ...OLD_ROW, cacheTtl: '5m', steps: [step()] } },
      },
    ] as never);
    expect(JSON.stringify(projected)).not.toContain('content_search');
    expect(JSON.stringify(projected)).not.toContain('cacheTtl');
  });
});
