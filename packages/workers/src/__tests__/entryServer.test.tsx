/**
 * The two server entries behind `@classmoji/workers/entry-server`:
 * - Node (`default`) is React Router's own default entry, byte for byte apart
 *   from the `// classmoji` lines (reporting), so Fly renders exactly as before;
 * - Workers (`workerd`) renders the same documents on web streams.
 * `ServerRouter` is replaced by a small document with a suspended part, so
 * both entries can be driven with the same inputs.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Suspense, use } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryContext, RouterContextProvider } from 'react-router';
import { setErrorReporter, type ReportContext } from '@classmoji/utils/error-report';

vi.mock('react-router', () => ({
  ServerRouter: ({ context, url }: { context: { late?: Promise<string> }; url: string }) => (
    <html lang="en">
      <body>
        <p>{url}</p>
        {context.late && (
          <Suspense fallback={<i>loading</i>}>
            <Late value={context.late} />
          </Suspense>
        )}
      </body>
    </html>
  ),
}));

function Late({ value }: { value: Promise<string> }) {
  return <b>{use(value)}</b>;
}

const node = await import('../entry-server.node.tsx');
const workerd = await import('../entry-server.workerd.tsx');

const ENTRIES = [
  ['node', node],
  ['workerd', workerd],
] as const;

const BOT = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function render(
  entry: (typeof ENTRIES)[number][1],
  {
    method = 'GET',
    userAgent = BROWSER,
    late,
  }: { method?: string; userAgent?: string; late?: Promise<string> } = {}
) {
  return entry.default(
    new Request('https://admin.example.com/people', {
      method,
      headers: { 'user-agent': userAgent },
    }),
    200,
    new Headers({ 'x-app': 'kept' }),
    { isSpaMode: false, late } as unknown as EntryContext,
    {} as RouterContextProvider
  ) as Promise<Response>;
}

describe('the Node entry', () => {
  it("is React Router's default entry.server.node.tsx, byte for byte, plus the marked lines", () => {
    const require = createRequire(import.meta.url);
    const defaults = require
      .resolve('@react-router/dev/package.json')
      .replace(/package\.json$/, 'dist/config/defaults/entry.server.node.tsx');
    const source = readFileSync(new URL('../entry-server.node.tsx', import.meta.url), 'utf8');
    const theirs = readFileSync(defaults, 'utf8');
    // Our additions are whole lines ending in `// classmoji`: exactly the
    // reportError import and its one call.
    const marked = source.split('\n').filter(line => line.endsWith(' // classmoji'));
    expect(marked.map(line => line.trim())).toEqual([
      'import { reportError } from "@classmoji/utils/error-report"; // classmoji',
      'reportError(error, { surface: "react_router.render" }); // classmoji',
    ]);
    const ours = source
      .split('\n')
      .filter(line => !line.endsWith(' // classmoji'))
      .join('\n');
    expect(ours.endsWith(theirs)).toBe(true);
    // Only the header comment and the eslint pragma precede it.
    expect(ours.slice(0, ours.length - theirs.length)).toMatch(
      /^\/\*\*[\s\S]*\*\/\n\/\* eslint-disable[^\n]*\*\/\n$/
    );
  });
});

describe.each(ENTRIES)('the %s entry', (_name, entry) => {
  it('exports the same streamTimeout', () => {
    expect(entry.streamTimeout).toBe(5_000);
  });

  it('renders the document as text/html, keeping the headers', async () => {
    const response = await render(entry);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('x-app')).toBe('kept');
    expect(await response.text()).toContain('<p>https://admin.example.com/people</p>');
  });

  it('answers HEAD with no body', async () => {
    const response = await render(entry, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('x-app')).toBe('kept');
  });

  it('streams the shell to browsers before suspended content resolves', async () => {
    let resolve!: (value: string) => void;
    const late = new Promise<string>(r => (resolve = r));
    const response = await render(entry, { late });
    // The response exists while the content is still pending.
    resolve('ready');
    const html = await response.text();
    expect(html).toContain('<i>loading</i>');
    expect(html).toContain('ready');
  });

  describe('an error after the shell', () => {
    let reported: Array<{ error: unknown; context: ReportContext }>;
    let logged: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      reported = [];
      logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      setErrorReporter(null);
      logged.mockRestore();
    });

    const renderFailingLate = async () => {
      let reject!: (error: Error) => void;
      const late = new Promise<string>((_resolve, r) => (reject = r));
      const response = await render(entry, { late });
      const error = new Error('late boom');
      reject(error);
      const html = await response.text();
      return { error, html, response };
    };

    it('is logged as before and reported once, as react_router.render', async () => {
      setErrorReporter({
        capture: (error, context) => reported.push({ error, context }),
        flush: async () => true,
      });
      const { error, html, response } = await renderFailingLate();
      expect(response.status).toBe(200);
      expect(html).toContain('<i>loading</i>');
      expect(logged).toHaveBeenCalledWith(error);
      expect(reported).toEqual([{ error, context: { surface: 'react_router.render' } }]);
    });

    it('without a reporter is only logged, and the response is unchanged', async () => {
      const { error, html, response } = await renderFailingLate();
      expect(response.status).toBe(200);
      expect(html).toContain('<i>loading</i>');
      expect(logged).toHaveBeenCalledWith(error);
      expect(reported).toEqual([]);
    });
  });

  it('waits for all content for bots', async () => {
    let resolve!: (value: string) => void;
    const late = new Promise<string>(r => (resolve = r));
    const pending = render(entry, { userAgent: BOT, late });
    setTimeout(() => resolve('ready'), 5);
    const html = await (await pending).text();
    expect(html).not.toContain('<i>loading</i>');
    expect(html).toContain('<b>ready</b>');
  });
});
