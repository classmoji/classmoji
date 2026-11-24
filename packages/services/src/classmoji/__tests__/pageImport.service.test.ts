/**
 * pageImport — the caller half of the `page-import-convert` task: trigger by
 * id, wait with a deadline, and turn every way it can end without blocks into
 * a PageImportError whose message a person reads.
 *
 * Pinned: Trigger not configured refuses before anything is sent; an oversized
 * input (characters, or serialized bytes) is refused before the trigger; the
 * payload carries names (never bytes) and the caller's slides origin; a failed
 * run, a timeout (cancelled), a structured `too_large` answer, a completed run
 * without blocks and an answer naming an upload it was not given are all
 * PageImportErrors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trigger: vi.fn(),
  cancel: vi.fn(),
  wait: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.trigger(...a) },
  runs: { cancel: (...a: unknown[]) => mocks.cancel(...a) },
}));
vi.mock('../../helper/runWait.ts', () => ({
  waitForRunOutcome: (...a: unknown[]) => mocks.wait(...a),
}));

const pageImport = await import('../pageImport.service.ts');
const { PAGE_IMPORT_MESSAGES, PAGE_IMPORT_PAYLOAD_MAX_BYTES } =
  await import('../pageImport.contract.ts');

const options = {
  org: 'test-org',
  repo: 'content-cs101',
  contentPath: 'pages/lab',
  assetsFolder: 'pages/lab/assets',
  provider: 'GITHUB',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  vi.stubEnv('TRIGGER_SECRET_KEY', 'tr_test_x');
  vi.stubEnv('TRIGGER_ACCESS_TOKEN', '');
  vi.stubEnv('SLIDES_URL', 'https://slides.example.test');
  mocks.trigger.mockResolvedValue({ id: 'run_1' });
  mocks.cancel.mockResolvedValue({});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const reasonOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(pageImport.isPageImportError(error)).toBe(true);
  return error as InstanceType<typeof pageImport.PageImportError>;
};

describe('availability', () => {
  it('is Trigger being configured in this process', () => {
    expect(pageImport.isPageImportAvailable()).toBe(true);
    vi.stubEnv('TRIGGER_SECRET_KEY', '');
    expect(pageImport.isPageImportAvailable()).toBe(false);
  });

  it('refuses without Trigger, before sending anything', async () => {
    vi.stubEnv('TRIGGER_SECRET_KEY', '');
    const error = await reasonOf(pageImport.convertHtml({ html: '<p>x</p>' }));
    expect(error.reason).toBe('unavailable');
    expect(error.message).toBe(PAGE_IMPORT_MESSAGES.unavailable);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });
});

describe('convertHtml', () => {
  it('triggers the task by id with the html and title, and returns its blocks', async () => {
    mocks.wait.mockResolvedValue({
      outcome: 'completed',
      output: { ok: true, blocks: [{ a: 1 }] },
    });
    await expect(pageImport.convertHtml({ html: '<p>x</p>', title: 'T' })).resolves.toEqual([
      { a: 1 },
    ]);
    expect(mocks.trigger).toHaveBeenCalledWith(
      'page-import-convert',
      { kind: 'html', html: '<p>x</p>', title: 'T' },
      { ttl: '2m' }
    );
    expect(mocks.wait).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({ timeoutMs: 35_000, failFastStatuses: ['PENDING_VERSION'] })
    );
  });

  it('passes the caller’s deadline to the wait', async () => {
    mocks.wait.mockResolvedValue({ outcome: 'completed', output: { ok: true, blocks: [] } });
    await pageImport.convertHtml({ html: '<p>x</p>' }, { timeoutMs: 30_000 });
    expect(mocks.wait).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({ timeoutMs: 30_000 })
    );
  });

  it('refuses a payload whose JSON is over the byte cap, before triggering', async () => {
    // 500,000 characters, but each a control character JSON writes as \u0001.
    const error = await reasonOf(pageImport.convertHtml({ html: '\u0001'.repeat(500_000) }));
    expect(error.reason).toBe('too_large');
    expect(error.message).toBe(PAGE_IMPORT_MESSAGES.too_large);
    expect(PAGE_IMPORT_PAYLOAD_MAX_BYTES).toBeLessThan(3_000_000);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('refuses html over the character cap', async () => {
    const error = await reasonOf(pageImport.convertHtml({ html: 'x'.repeat(500_001) }));
    expect(error.reason).toBe('too_large');
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it.each([
    ['a failed run', { outcome: 'failed', status: 'FAILED' }, 'failed'],
    ['a completed run with no output', { outcome: 'completed', output: undefined }, 'failed'],
    ['a completed run with no blocks', { outcome: 'completed', output: { ok: true } }, 'failed'],
    [
      'the task answering too_large',
      { outcome: 'completed', output: { ok: false, code: 'too_large' } },
      'too_large',
    ],
  ])('%s is a PageImportError', async (_label, outcome, reason) => {
    mocks.wait.mockResolvedValue(outcome);
    const error = await reasonOf(pageImport.convertHtml({ html: '<p>x</p>' }));
    expect(error.reason).toBe(reason);
    expect(error.message).toBe(PAGE_IMPORT_MESSAGES[reason as 'failed']);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('a timeout is a PageImportError and cancels the run', async () => {
    mocks.wait.mockResolvedValue({ outcome: 'timeout', status: 'PENDING_VERSION' });
    const error = await reasonOf(pageImport.convertHtml({ html: '<p>x</p>' }));
    expect(error.reason).toBe('timeout');
    expect(error.message).toBe(PAGE_IMPORT_MESSAGES.timeout);
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('run_1'));
  });

  it('a run the worker cannot take yet (PENDING_VERSION) is unavailable, and cancelled', async () => {
    mocks.wait.mockResolvedValue({ outcome: 'failed', status: 'PENDING_VERSION' });
    const error = await reasonOf(pageImport.convertHtml({ html: '<p>x</p>' }));
    expect(error.reason).toBe('unavailable');
    expect(error.message).toBe(PAGE_IMPORT_MESSAGES.unavailable);
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('run_1'));
  });

  it('refuses a title over the parser’s cap before triggering', async () => {
    const error = await reasonOf(
      pageImport.convertHtml({ html: '<p>x</p>', title: 't'.repeat(1_001) })
    );
    expect(error.reason).toBe('title_too_long');
    expect(error.message).toBe(PAGE_IMPORT_MESSAGES.title_too_long);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('a trigger that throws is a PageImportError', async () => {
    mocks.trigger.mockRejectedValue(new Error('401 unauthorized'));
    const error = await reasonOf(pageImport.convertHtml({ html: '<p>x</p>' }));
    expect(error.reason).toBe('failed');
    expect(mocks.wait).not.toHaveBeenCalled();
  });
});

describe('convertMarkdown', () => {
  const okOutput = {
    ok: true,
    blocks: [{ type: 'paragraph' }],
    images: [
      {
        originalPath: 'img/a.png',
        index: 1,
        newPath: 'pages/lab/assets/a-1.png',
        newFilename: 'a-1.png',
        githubUrl:
          'https://raw.githubusercontent.com/test-org/content-cs101/main/pages/lab/assets/a-1.png',
      },
    ],
    unmatched: [0],
    missing: ['gone.png'],
  };

  it('sends the images’ names only, and the caller’s slides origin', async () => {
    mocks.wait.mockResolvedValue({ outcome: 'completed', output: okOutput });
    const result = await pageImport.convertMarkdown({
      markdown: '# Lab\n\n![a](img/a.png)',
      title: 'Lab',
      imageNames: ['extra.png', 'a.png'],
      options,
    });
    expect(mocks.trigger).toHaveBeenCalledWith(
      'page-import-convert',
      {
        kind: 'markdown',
        markdown: '# Lab\n\n![a](img/a.png)',
        title: 'Lab',
        images: ['extra.png', 'a.png'],
        options: { ...options, slidesUrl: 'https://slides.example.test' },
      },
      { ttl: '2m' }
    );
    expect(result).toEqual({
      blocks: okOutput.blocks,
      images: okOutput.images,
      unmatched: [0],
      missing: ['gone.png'],
    });
  });

  it('markdown has no character cap of its own: a ~1 MB data: image is sent', async () => {
    mocks.wait.mockResolvedValue({ outcome: 'completed', output: { ok: true, blocks: [] } });
    const markdown = `# Doc\n\n![shot](data:image/png;base64,${'A'.repeat(1_000_000)})\n`;
    await pageImport.convertMarkdown({ markdown, imageNames: [], options });
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
  });

  it('refuses markdown over the payload guard before triggering', async () => {
    const error = await reasonOf(
      pageImport.convertMarkdown({
        markdown: `![shot](data:image/png;base64,${'A'.repeat(PAGE_IMPORT_PAYLOAD_MAX_BYTES)})`,
        imageNames: [],
        options,
      })
    );
    expect(error.reason).toBe('too_large');
    expect(error.message).toBe(PAGE_IMPORT_MESSAGES.too_large);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it('rebuilds each newPath from the caller’s assets folder, never the answer’s', async () => {
    mocks.wait.mockResolvedValue({
      outcome: 'completed',
      output: {
        ...okOutput,
        images: [{ ...okOutput.images[0], newPath: '../../.github/workflows/a.yml' }],
      },
    });
    const result = await pageImport.convertMarkdown({
      markdown: '# x',
      imageNames: ['extra.png', 'a.png'],
      options,
    });
    expect(result.images[0].newPath).toBe('pages/lab/assets/a-1.png');
  });

  it.each([
    ['a traversal', '../../.github/workflows/a.yml'],
    ['a dot-dot name', 'a..png'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'a\\b.png'],
    ['a nested path', 'sub/a.png'],
    ['an upper-case name', 'A.png'],
    ['an empty name', ''],
    ['a hidden name', '.github'],
  ])('a newFilename that is %s is a failure, nothing returned', async (_label, newFilename) => {
    mocks.wait.mockResolvedValue({
      outcome: 'completed',
      output: { ...okOutput, images: [{ ...okOutput.images[0], newFilename }] },
    });
    const error = await reasonOf(
      pageImport.convertMarkdown({ markdown: '# x', imageNames: ['a.png', 'b.png'], options })
    );
    expect(error.reason).toBe('failed');
  });

  it('accepts the importer’s name for a file whose name starts with a symbol', async () => {
    mocks.wait.mockResolvedValue({
      outcome: 'completed',
      output: { ...okOutput, images: [{ ...okOutput.images[0], newFilename: '-x-1700.png' }] },
    });
    const result = await pageImport.convertMarkdown({
      markdown: '# x',
      imageNames: ['a.png', '_x.png'],
      options,
    });
    expect(result.images[0].newPath).toBe('pages/lab/assets/-x-1700.png');
  });

  it.each([
    ['images is not an array', { images: { 0: okOutput.images[0] } }],
    ['an image is not an object', { images: ['a.png'] }],
    ['an image lacks its url', { images: [{ ...okOutput.images[0], githubUrl: 7 }] }],
    ['unmatched is not an array', { unmatched: 0 }],
    ['unmatched holds a non-index', { unmatched: ['0'] }],
    ['missing is not an array', { missing: 'gone.png' }],
    ['missing holds a non-string', { missing: [1] }],
  ])('an answer where %s is a failure', async (_label, patch) => {
    mocks.wait.mockResolvedValue({ outcome: 'completed', output: { ...okOutput, ...patch } });
    const error = await reasonOf(
      pageImport.convertMarkdown({ markdown: '# x', imageNames: ['a.png', 'b.png'], options })
    );
    expect(error.reason).toBe('failed');
  });

  it('an answer naming an upload it was not given is a failure', async () => {
    mocks.wait.mockResolvedValue({
      outcome: 'completed',
      output: { ...okOutput, images: [{ ...okOutput.images[0], index: 5 }] },
    });
    const error = await reasonOf(
      pageImport.convertMarkdown({ markdown: '# x', imageNames: ['a.png', 'b.png'], options })
    );
    expect(error.reason).toBe('failed');
  });
});
