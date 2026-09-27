/**
 * Unit tests for how the explore-repo task reads the exploration model's answer.
 *
 * Focus: when Sonnet 5 or Opus 5.5 decides to think, it returns a `thinking`
 * block BEFORE the text block. Reading `content[0]` then yields no text, and the
 * task silently explores nothing — an empty file list and empty findings, with
 * no error anywhere. These tests pin that the answer is taken from the first
 * text block, that a missing or cut-short answer falls back AND is logged, that
 * no `thinking` param is sent (Opus 5.5 rejects `disabled`), and that the
 * excerpt selector strips the outer ```json fence Sonnet 5 wraps its answer in.
 * `@trigger.dev/sdk/v3` is mocked and the Anthropic client is a stub — nothing
 * reaches the API.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  warn: vi.fn(),
}));

// exploreRepo.ts imports the `/v3` subpath, so that is the path to mock.
vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => mocks.warn(...a) },
  metadata: { set: vi.fn(), append: vi.fn(), flush: vi.fn() },
}));

vi.spyOn(console, 'log').mockImplementation(() => {});

const { pickRelevantFiles, requestExcerptPointers } = await import('../exploreRepo.ts');

const client = { messages: { create: mocks.create } } as unknown as Anthropic;

const THINKING = { type: 'thinking', thinking: '', signature: 'sig' };

const message = (content: unknown[], stop_reason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50 },
});

const pick = () =>
  pickRelevantFiles(
    client,
    'claude-opus-5-5',
    'src/App.jsx (1.0KB)',
    'initial',
    'focused',
    [],
    null
  );

const select = () =>
  requestExcerptPointers(
    client,
    'claude-opus-5-5',
    [{ path: 'src/App.jsx', content: 'export default function App() {}' }],
    'initial',
    [],
    null,
    'src/App.jsx (1.0KB)'
  );

beforeEach(() => {
  mocks.create.mockReset();
  mocks.warn.mockReset();
});

describe('pickRelevantFiles', () => {
  it('parses the text block that follows a thinking block', async () => {
    mocks.create.mockResolvedValue(
      message([THINKING, { type: 'text', text: '```json\n["src/App.jsx", "src/utils.js"]\n```' }])
    );

    await expect(pick()).resolves.toEqual(['src/App.jsx', 'src/utils.js']);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('falls back to no files, and says so, when no text block comes back', async () => {
    mocks.create.mockResolvedValue(message([THINKING], 'max_tokens'));

    await expect(pick()).resolves.toEqual([]);
    const warnings = mocks.warn.mock.calls.map(call => String(call[0]));
    expect(warnings).toEqual([
      expect.stringContaining('File picker: claude-opus-5-5 stopped with max_tokens'),
      expect.stringContaining('File picker: claude-opus-5-5 returned no text block'),
    ]);
  });

  it('sends no thinking param and leaves room for thinking in max_tokens', async () => {
    mocks.create.mockResolvedValue(message([{ type: 'text', text: '[]' }]));

    await pick();
    const params = mocks.create.mock.calls[0][0];
    expect(params).not.toHaveProperty('thinking');
    expect(params.max_tokens).toBe(4096);
  });

  it('keeps only paths, each once, without "./", and no more than the depth allows', async () => {
    // A non-string used to crash the initial call's summary at `p.split`, and
    // a repeat was fetched and shown to the excerpt model twice.
    mocks.create.mockResolvedValue(
      message([
        {
          type: 'text',
          text: '["src/App.jsx", {"path": "x.js"}, 7, " ./src/App.jsx ", "", "a.js", "b.js", "c.js", "d.js"]',
        },
      ])
    );

    // 'focused' allows 4.
    await expect(pick()).resolves.toEqual(['src/App.jsx', 'a.js', 'b.js', 'c.js']);
  });
});

describe('requestExcerptPointers', () => {
  const POINTERS =
    '{"excerpts": [{"path": "src/App.jsx", "start_line": 1, "end_line": 1, "why": "the component"}]}';
  const PARSED = {
    overview: null,
    pointers: [
      { path: 'src/App.jsx', startLine: 1, endLine: 1, wholeFile: false, why: 'the component' },
    ],
  };

  it('parses the text block that follows a thinking block', async () => {
    mocks.create.mockResolvedValue(message([THINKING, { type: 'text', text: POINTERS }]));

    await expect(select()).resolves.toEqual(PARSED);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('returns null, and says so, when no text block comes back', async () => {
    mocks.create.mockResolvedValue(message([THINKING]));

    await expect(select()).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(String(mocks.warn.mock.calls[0][0])).toContain(
      'Excerpt selector: claude-opus-5-5 returned no text block (blocks: thinking, stop_reason: end_turn)'
    );
  });

  it('warns on a truncated answer and returns null for the half-written JSON', async () => {
    mocks.create.mockResolvedValue(
      message([THINKING, { type: 'text', text: '{"excerpts": [{"path": "src/Ap' }], 'max_tokens')
    );

    await expect(select()).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(String(mocks.warn.mock.calls[0][0])).toContain(
      'Excerpt selector: claude-opus-5-5 stopped with max_tokens'
    );
  });

  it('warns on a refusal, which is not a max_tokens stop but still cuts the answer short', async () => {
    mocks.create.mockResolvedValue(message([], 'refusal'));

    await expect(select()).resolves.toBeNull();
    const warnings = mocks.warn.mock.calls.map(call => String(call[0]));
    expect(warnings).toEqual([
      expect.stringContaining('Excerpt selector: claude-opus-5-5 stopped with refusal'),
      expect.stringContaining('returned no text block (blocks: none, stop_reason: refusal)'),
    ]);
  });

  it('strips an outer ```json fence', async () => {
    mocks.create.mockResolvedValue(
      message([{ type: 'text', text: '```json\n' + POINTERS + '\n```\n' }])
    );

    await expect(select()).resolves.toEqual(PARSED);
  });

  it('reads the object out of prose around it', async () => {
    mocks.create.mockResolvedValue(
      message([
        { type: 'text', text: 'Here are the excerpts:\n' + POINTERS + '\nHope that helps.' },
      ])
    );

    await expect(select()).resolves.toEqual(PARSED);
  });

  it('sends the files with line numbers, and no thinking param', async () => {
    mocks.create.mockResolvedValue(message([{ type: 'text', text: POINTERS }]));

    await select();
    const params = mocks.create.mock.calls[0][0];
    expect(params).not.toHaveProperty('thinking');
    // Thinking counts against max_tokens and this call reads the code. With no
    // effort (the API's default, high) it gets four times the picker's room;
    // exploreRepo.effort.test.ts covers the other levels.
    expect(params.max_tokens).toBe(16384);
    const prompt = params.messages[0].content as string;
    expect(prompt).toContain(
      '### FILE: src/App.jsx (1 lines)\n1| export default function App() {}'
    );
    // The initial call asks for the overview; others do not.
    expect(prompt).toContain('"overview"');
  });
});
