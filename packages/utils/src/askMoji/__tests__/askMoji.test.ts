/**
 * Ask Moji's public contracts: the tool allow-list by role, the projection
 * registry, the data parts and the fixed copy.
 */
import { describe, expect, it } from 'vitest';
import {
  ASK_MOJI_COPY,
  ASK_MOJI_COPY_CODES,
  ASK_MOJI_ERROR_COPY,
  ASK_MOJI_INSTRUCTOR_SUGGESTIONS,
  ASK_MOJI_REFUSALS,
  ASK_MOJI_STUDENT_SUGGESTIONS,
  ASK_MOJI_WELCOME,
  AskMojiMessageMetadataSchema,
  AskMojiNoticeDataSchema,
  AskMojiStepDataSchema,
  CONTRACT_VERSION,
  CiteContentInputSchema,
  CiteContentOutputSchema,
  MAX_LOOKUPS_PER_TURN,
  MAX_MESSAGE_CHARS,
  MAX_STEPS_PER_TURN,
  MIN_TURN_INTERVAL_MS,
  START_RATE_LIMIT,
  TURN_DEADLINE_MS,
  actingRole,
  askMojiCopyFor,
  askMojiToolDefs,
  askMojiVisibility,
  createChunkProjector,
  isAskMojiErrorCopy,
  isPermanentRefusal,
  projectMessage,
  suggestionsForRole,
  toolVisibility,
  type AskMojiUIMessage,
} from '../index.ts';
import * as agentLimits from '../../agents/limits.ts';

describe('actingRole', () => {
  it('is the strongest role at or below the ceiling', () => {
    expect(actingRole(['STUDENT', 'ASSISTANT'], 'STUDENT')).toBe('STUDENT');
    expect(actingRole(['STUDENT', 'ASSISTANT'], null)).toBe('ASSISTANT');
    expect(actingRole(['OWNER'], 'TEACHER')).toBeNull();
    expect(actingRole(['TEACHER', 'STUDENT'], 'OWNER')).toBe('TEACHER');
  });

  it('admits nothing under a ceiling that is not a role', () => {
    expect(actingRole(['OWNER'], 'owner')).toBeNull();
    expect(actingRole(['OWNER'], '')).toBeNull();
  });
});

describe('askMojiVisibility', () => {
  it('declares cite_content only, shown', () => {
    expect(Object.keys(askMojiVisibility.tools)).toEqual(['cite_content']);
    expect(toolVisibility(askMojiVisibility, 'cite_content')).toBe('shown');
  });

  it('hides every MCP tool, live and stored', () => {
    for (const name of ['content_search', 'get_roster', 'my_grades', 'grade_add']) {
      expect(toolVisibility(askMojiVisibility, name)).toBe('hidden');
    }
    expect(toolVisibility(askMojiVisibility, 'constructor')).toBe('hidden');
    const project = createChunkProjector(askMojiVisibility);
    expect(
      project({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'grade_add' } as never)
    ).toBeNull();
    expect(
      project({ type: 'tool-output-available', toolCallId: 'c1', output: { x: 1 } } as never)
    ).toBeNull();
  });

  it('drops MCP tool parts and reasoning from a stored message, keeping cites, text and steps', () => {
    const message = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: 'thinking' },
        {
          type: 'tool-content_search',
          toolCallId: 't1',
          state: 'output-available',
          input: { query: 'late policy' },
          output: { results: ['secret'] },
        },
        { type: 'data-step', data: { title: 'Searching the course materials' } },
        { type: 'text', text: 'The late policy is…' },
        {
          type: 'tool-cite_content',
          toolCallId: 't2',
          state: 'output-available',
          input: { type: 'page', id: 'p1' },
          output: { ok: true, title: 'Syllabus', url: 'https://pages.example/p1' },
        },
      ],
    } as unknown as AskMojiUIMessage;
    const projected = projectMessage(message, askMojiVisibility);
    expect(projected?.parts.map(p => p.type)).toEqual([
      'step-start',
      'data-step',
      'text',
      'tool-cite_content',
    ]);
  });

  it('passes only declared data parts, re-validated', () => {
    const project = createChunkProjector(askMojiVisibility);
    expect(project({ type: 'data-notice', data: { code: 'PACE' } } as never)).toEqual({
      type: 'data-notice',
      data: { code: 'PACE' },
    });
    expect(project({ type: 'data-notice', data: { code: 'made up' } } as never)).toBeNull();
    expect(
      project({ type: 'data-step', data: { title: 'Checking the calendar', extra: 1 } } as never)
    ).toEqual({ type: 'data-step', data: { title: 'Checking the calendar' } });
    expect(project({ type: 'data-step', data: { title: '' } } as never)).toBeNull();
    expect(project({ type: 'data-evaluation', data: {} } as never)).toBeNull();
    expect(project({ type: 'reasoning-delta', id: 'r', delta: 'x' } as never)).toBeNull();
  });
});

describe('data parts and the cite tool', () => {
  it('parses notice and step', () => {
    expect(AskMojiNoticeDataSchema.safeParse({ code: 'MCP_UNAVAILABLE' }).success).toBe(true);
    expect(AskMojiNoticeDataSchema.safeParse({ code: 'mcp_unavailable' }).success).toBe(false);
    expect(AskMojiStepDataSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('defines cite_content without descriptions', () => {
    expect(Object.keys(askMojiToolDefs)).toEqual(['cite_content']);
    expect(CiteContentInputSchema.safeParse({ type: 'platform_docs', path: '/x' }).success).toBe(
      true
    );
    expect(CiteContentInputSchema.safeParse({ type: 'repo', id: 'x' }).success).toBe(false);
    expect(CiteContentOutputSchema.safeParse({ ok: false }).success).toBe(true);
    expect(CiteContentOutputSchema.safeParse({ ok: true, url: null }).success).toBe(true);
    const described = [
      CiteContentInputSchema,
      CiteContentOutputSchema,
      ...Object.values(CiteContentInputSchema.shape),
      ...Object.values(CiteContentOutputSchema.shape),
    ].filter(s => s.description !== undefined);
    expect(described).toEqual([]);
  });
});

describe('message metadata', () => {
  it('takes at most a strictly shaped `viewing`', () => {
    const ok = (v: unknown) => AskMojiMessageMetadataSchema.safeParse(v).success;
    expect(ok({})).toBe(true);
    expect(ok({ viewing: { kind: 'assignment', id: 'a1' } })).toBe(true);
    expect(ok({ viewing: { kind: 'calendar' } })).toBe(true);
    expect(ok({ viewing: { kind: 'repo', id: 'a1' } })).toBe(false);
    expect(ok({ viewing: { kind: 'page', id: '' } })).toBe(false);
    expect(ok({ viewing: { kind: 'page', id: 'p', title: 'x' } })).toBe(false);
    expect(ok({ viewing: { kind: 'page' }, hidden: true })).toBe(false);
    expect(ok({ role: 'OWNER' })).toBe(false);
  });
});

describe('copy', () => {
  it("keeps today's welcome and suggestion sets", () => {
    expect(ASK_MOJI_WELCOME).toBe(
      "Hi! I'm your course assistant. Ask me anything about the syllabus, assignments, or course content!"
    );
    expect(ASK_MOJI_STUDENT_SUGGESTIONS.map(s => s.text)).toEqual([
      'What assignments are due this week?',
      'How do I check my quiz scores?',
      "What's the late policy?",
      'How do I get help with an assignment?',
    ]);
    expect(ASK_MOJI_INSTRUCTOR_SUGGESTIONS).toHaveLength(4);
  });

  it('splits suggestions as today: TEACHER/OWNER instructor, ASSISTANT/STUDENT student', () => {
    expect(suggestionsForRole('TEACHER')).toBe(ASK_MOJI_INSTRUCTOR_SUGGESTIONS);
    expect(suggestionsForRole('OWNER')).toBe(ASK_MOJI_INSTRUCTOR_SUGGESTIONS);
    expect(suggestionsForRole('ASSISTANT')).toBe(ASK_MOJI_STUDENT_SUGGESTIONS);
    expect(suggestionsForRole('STUDENT')).toBe(ASK_MOJI_STUDENT_SUGGESTIONS);
  });

  it("carries today's lines word for word", () => {
    expect(ASK_MOJI_COPY.INIT_FAILED).toBe('Could not start the assistant. Please try again.');
    expect(ASK_MOJI_COPY.SEND_FAILED).toBe('Could not send your message. Please try again.');
    expect(ASK_MOJI_COPY.CONVERSATION_ENDED).toBe(
      'This conversation has ended. Start a new one to keep asking.'
    );
    expect(ASK_MOJI_COPY.UNAVAILABLE).toBe("Ask Moji isn't available in this class.");
    expect(ASK_MOJI_COPY.NOT_ENABLED).toBe('Ask Moji is not enabled for this course.');
  });

  it('has a line for every refusal and notice code, and allows exactly those lines', () => {
    for (const code of Object.keys(ASK_MOJI_REFUSALS)) {
      expect(ASK_MOJI_COPY_CODES).toContain(code);
    }
    for (const code of [
      'MCP_UNAVAILABLE',
      'NO_API_KEY',
      'PACE',
      'CLASSROOM_LOCKED',
      'NOT_ALLOWED',
      'BUSY',
      'RATE_LIMITED',
      'SESSION_ENDED',
    ]) {
      expect(ASK_MOJI_COPY_CODES).toContain(code);
    }
    for (const line of Object.values(ASK_MOJI_COPY)) {
      expect(isAskMojiErrorCopy(line)).toBe(true);
      expect(line.trim()).not.toBe('');
    }
    expect(ASK_MOJI_ERROR_COPY.length).toBe(new Set(ASK_MOJI_ERROR_COPY).size);
    expect(isAskMojiErrorCopy('connect ECONNREFUSED 10.0.0.1:5432')).toBe(false);
    expect(askMojiCopyFor('nope')).toBe(ASK_MOJI_COPY.ERROR);
    expect(askMojiCopyFor('constructor')).toBe(ASK_MOJI_COPY.ERROR);
  });

  it('classes refusals', () => {
    expect(isPermanentRefusal('CONVERSATION_ENDED')).toBe(true);
    expect(isPermanentRefusal('NOT_A_MEMBER')).toBe(true);
    expect(isPermanentRefusal('SESSION_ENDED')).toBe(true);
    expect(isPermanentRefusal('PACE')).toBe(false);
    expect(isPermanentRefusal('UNAVAILABLE')).toBe(false);
    expect(isPermanentRefusal('CLASSROOM_LOCKED')).toBe(false);
  });
});

describe('limits', () => {
  it('states the D10 numbers and shares the pace with the quiz', () => {
    expect(MAX_MESSAGE_CHARS).toBe(4_000);
    expect(MAX_STEPS_PER_TURN).toBe(10);
    expect(MAX_LOOKUPS_PER_TURN).toBe(6);
    expect(TURN_DEADLINE_MS).toBe(120_000);
    expect(MIN_TURN_INTERVAL_MS).toBe(3_000);
    expect(MIN_TURN_INTERVAL_MS).toBe(agentLimits.MIN_TURN_INTERVAL_MS);
    expect(START_RATE_LIMIT).toEqual({ max: 10, windowMs: 600_000 });
    expect(CONTRACT_VERSION).toBe(1);
  });
});
