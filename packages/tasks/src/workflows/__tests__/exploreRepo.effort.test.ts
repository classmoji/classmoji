/**
 * explore-repo: reasoning effort on the excerpt call.
 *
 * The ai-agent resolves the exploration effort (classroom > EXPLORATION_EFFORT
 * > default), drops it for a model that takes none, and passes what is left as
 * `explorationEffort`. Pinned here: the excerpt call, and only it, carries
 * `output_config: { effort }`; a missing or unknown value sends nothing (an
 * unknown level would 400 the call); xhigh and max run as high, and max_tokens
 * follows the effort (8192 for low/medium, 16384 for high or none) so thinking
 * can't eat the whole answer; and, because @anthropic-ai/sdk 0.39 has no
 * `output_config` type, that the real SDK still puts the field on the wire and
 * accepts 16384 without a stream.
 * `@trigger.dev/sdk/v3` is mocked, the task's Anthropic client is a stub, and
 * the wire test hands the real SDK a stub `fetch`, so nothing reaches a network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => mocks.warn(...a) },
  metadata: { set: vi.fn(), append: vi.fn(), flush: vi.fn() },
}));

// The task builds its own client; the wire test below uses the real SDK.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mocks.create };
  },
}));

vi.spyOn(console, 'log').mockImplementation(() => {});

const {
  exploreRepoTask,
  requestExcerptPointers,
  toEffortLevel,
  capExcerptEffort,
  excerptMaxTokens,
  EFFORT_LEVELS,
} = await import('../exploreRepo.ts');

const POINTERS =
  '{"excerpts": [{"path": "style.css", "start_line": 1, "end_line": 3, "why": "header flex"}]}';

const message = (text: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

beforeEach(() => {
  mocks.create.mockReset();
  mocks.warn.mockReset();
});

describe('toEffortLevel', () => {
  it('keeps each of the five levels', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(toEffortLevel(level)).toBe(level);
    }
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it.each([[undefined], [null], [''], ['LOW'], [' low'], ['extreme'], [1], [{ effort: 'low' }]])(
    'turns %j into null',
    value => {
      expect(toEffortLevel(value)).toBeNull();
    }
  );
});

describe('excerpt call ceiling', () => {
  it('runs xhigh and max as high, and leaves the rest alone', () => {
    expect(capExcerptEffort('xhigh')).toBe('high');
    expect(capExcerptEffort('max')).toBe('high');
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(capExcerptEffort(level)).toBe(level);
    }
    expect(capExcerptEffort(null)).toBeNull();
  });

  it('gives low and medium 8192 tokens, high and no effort 16384', () => {
    expect(excerptMaxTokens('low')).toBe(8192);
    expect(excerptMaxTokens('medium')).toBe(8192);
    expect(excerptMaxTokens('high')).toBe(16384);
    expect(excerptMaxTokens(null)).toBe(16384);
  });
});

describe('explore-repo task run: explorationEffort', () => {
  const REPO_FILES: Record<string, string> = {
    'src/App.jsx': 'export default function App() {\n  return <h1>Hi</h1>;\n}\n',
    'style.css': '.header {\n  display: flex;\n}\n',
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/git/trees/')
          ? {
              tree: Object.keys(REPO_FILES).map(path => ({ path, type: 'blob', size: 100 })),
            }
          : {
              encoding: 'base64',
              content: Buffer.from(
                REPO_FILES[decodeURIComponent(url.split('/contents/')[1])]
              ).toString('base64'),
            };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    mocks.create
      .mockResolvedValueOnce(message('["style.css", "src/App.jsx"]'))
      .mockResolvedValueOnce(message(POINTERS));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (explorationEffort?: unknown) =>
    (
      exploreRepoTask as unknown as {
        run: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }
    ).run({
      owner: 'org',
      repo: 'repo',
      accessToken: 'ghs_x',
      focusArea: 'the header CSS rule',
      explorationEffort,
    });

  /** [file picker params, excerpt selector params] */
  const sentParams = () => {
    expect(mocks.create).toHaveBeenCalledTimes(2);
    return mocks.create.mock.calls.map(call => call[0] as Record<string, unknown>);
  };

  it('puts the effort on the excerpt call and not on the file picker', async () => {
    const result = await run('low');

    const [picker, excerpt] = sentParams();
    expect(picker).not.toHaveProperty('output_config');
    expect(excerpt.output_config).toEqual({ effort: 'low' });
    // The rest of the excerpt call is as before.
    expect(excerpt).not.toHaveProperty('thinking');
    expect(excerpt.max_tokens).toBe(8192);
    expect(result.excerpts).toHaveLength(1);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['medium', 'medium', 8192],
    ['high', 'high', 16384],
    ['xhigh', 'high', 16384],
    ['max', 'high', 16384],
  ])('runs %s as %s with max_tokens %i', async (given, sent, maxTokens) => {
    await run(given);

    const [picker, excerpt] = sentParams();
    expect(picker).not.toHaveProperty('output_config');
    expect(excerpt.output_config).toEqual({ effort: sent });
    expect(excerpt.max_tokens).toBe(maxTokens);
    // The file picker's room does not move with the effort.
    expect(picker.max_tokens).toBe(4096);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('sends no effort when none is given, with the high-effort room', async () => {
    await run(undefined);

    const [picker, excerpt] = sentParams();
    expect(picker).not.toHaveProperty('output_config');
    expect(excerpt).not.toHaveProperty('output_config');
    expect(excerpt.max_tokens).toBe(16384);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('sends no effort for an unknown level, and says so', async () => {
    await run('extreme');

    const [picker, excerpt] = sentParams();
    expect(picker).not.toHaveProperty('output_config');
    expect(excerpt).not.toHaveProperty('output_config');
    expect(mocks.warn).toHaveBeenCalledWith('Ignoring unknown explorationEffort "extreme"');
  });
});

describe('requestExcerptPointers on the real SDK', () => {
  // @anthropic-ai/sdk 0.39 has no `output_config` in its types; this proves the
  // client still serializes it into the request body.
  const bodies: Record<string, unknown>[] = [];
  let client: Anthropic;

  beforeEach(async () => {
    bodies.length = 0;
    const { default: RealAnthropic } =
      await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
    const stubFetch = async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(message(POINTERS)), {
        status: 200,
        // 0.39 parses the body as JSON only when the response says it is JSON.
        headers: { 'content-type': 'application/json' },
      });
    };
    client = new RealAnthropic({ apiKey: 'sk-test', maxRetries: 0, fetch: stubFetch as never });
  });

  const select = (effort?: (typeof EFFORT_LEVELS)[number] | null) =>
    requestExcerptPointers(
      client,
      'claude-sonnet-5',
      [{ path: 'style.css', content: '.header {\n  display: flex;\n}\n' }],
      'the header CSS rule',
      [],
      null,
      'style.css (0.1KB)',
      effort
    );

  it('sends output_config.effort in the request body', async () => {
    const parsed = await select('low');

    expect(bodies).toHaveLength(1);
    expect(bodies[0].output_config).toEqual({ effort: 'low' });
    expect(bodies[0].model).toBe('claude-sonnet-5');
    // The response still parses through the real client.
    expect(parsed?.pointers).toHaveLength(1);
  });

  it('sends no output_config without an effort', async () => {
    await select(null);
    await select();

    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).not.toHaveProperty('output_config');
  });

  // 0.39 refuses a non-streaming create whose max_tokens implies more than ten
  // minutes (3600 * max_tokens / 128000 > 600, so above ~21,333), throwing
  // before anything is sent. The task's client sets no timeout, so the guard
  // applies to it.
  it('gets 16384 past the non-streaming guard at high, max and no effort', async () => {
    await select('high');
    await select('max');
    await select(null);

    expect(bodies.map(body => [body.max_tokens, body.output_config])).toEqual([
      [16384, { effort: 'high' }],
      [16384, { effort: 'high' }],
      [16384, undefined],
    ]);
  });

  it('is up against a live guard (a larger max_tokens throws before sending)', () => {
    expect(() =>
      client.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 21334,
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).toThrow(/Streaming is strongly recommended/);
    expect(bodies).toHaveLength(0);
  });
});
