/**
 * Unit tests for how the explore-repo task reads the exploration model's answer.
 *
 * Focus: when Sonnet 5 or Opus 5.5 decides to think, it returns a `thinking`
 * block BEFORE the text block. Reading `content[0]` then yields no text, and the
 * task silently explores nothing — an empty file list and empty findings, with
 * no error anywhere. These tests pin that the answer is taken from the first
 * text block, that a missing or cut-short answer falls back AND is logged, that
 * no `thinking` param is sent (Opus 5.5 rejects `disabled`), and that the
 * synthesizer strips the outer ```json fence Sonnet 5 wraps its answer in.
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

const { pickRelevantFiles, synthesizeFindings } = await import('../exploreRepo.ts');

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

const synthesize = () =>
  synthesizeFindings(
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
});

describe('synthesizeFindings', () => {
  it('returns the text block that follows a thinking block', async () => {
    const findings = '{"focus_area": "initial", "relevant_files": []}';
    mocks.create.mockResolvedValue(message([THINKING, { type: 'text', text: findings }]));

    await expect(synthesize()).resolves.toBe(findings);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('falls back to an empty object, and says so, when no text block comes back', async () => {
    mocks.create.mockResolvedValue(message([THINKING]));

    await expect(synthesize()).resolves.toBe('{}');
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(String(mocks.warn.mock.calls[0][0])).toContain(
      'Synthesizer: claude-opus-5-5 returned no text block (blocks: thinking, stop_reason: end_turn)'
    );
  });

  it('warns on a truncated answer but still returns what came back', async () => {
    mocks.create.mockResolvedValue(
      message([THINKING, { type: 'text', text: '{"focus_area": "ini' }], 'max_tokens')
    );

    await expect(synthesize()).resolves.toBe('{"focus_area": "ini');
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(String(mocks.warn.mock.calls[0][0])).toContain(
      'Synthesizer: claude-opus-5-5 stopped with max_tokens'
    );
  });

  it('warns on a refusal, which is not a max_tokens stop but still cuts the answer short', async () => {
    mocks.create.mockResolvedValue(message([], 'refusal'));

    await expect(synthesize()).resolves.toBe('{}');
    const warnings = mocks.warn.mock.calls.map(call => String(call[0]));
    expect(warnings).toEqual([
      expect.stringContaining('Synthesizer: claude-opus-5-5 stopped with refusal'),
      expect.stringContaining('returned no text block (blocks: none, stop_reason: refusal)'),
    ]);
  });

  it('strips the outer ```json fence but leaves a ``` inside a code_snippet alone', async () => {
    const inner = '{"relevant_files": [{"code_snippet": "```js\\nx()\\n```"}]}';
    mocks.create.mockResolvedValue(
      message([{ type: 'text', text: '```json\n' + inner + '\n```\n' }])
    );

    const findings = await synthesize();
    expect(findings).toBe(inner);
    expect(JSON.parse(findings).relevant_files[0].code_snippet).toBe('```js\nx()\n```');
  });

  it('returns an unfenced answer unchanged', async () => {
    const bare = '{"focus_area": "initial"}';
    mocks.create.mockResolvedValue(message([{ type: 'text', text: bare }]));

    await expect(synthesize()).resolves.toBe(bare);
  });

  it('sends no thinking param and leaves room for thinking in max_tokens', async () => {
    mocks.create.mockResolvedValue(message([{ type: 'text', text: '{}' }]));

    await synthesize();
    const params = mocks.create.mock.calls[0][0];
    expect(params).not.toHaveProperty('thinking');
    expect(params.max_tokens).toBe(8192);
  });
});
