/**
 * The two server entries behind `@classmoji/workers/entry-server`:
 * - Node (`default`) is React Router's own default entry, byte for byte, so
 *   Fly renders exactly as before;
 * - Workers (`workerd`) renders the same documents on web streams.
 * `ServerRouter` is replaced by a small document with a suspended part, so
 * both entries can be driven with the same inputs.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Suspense, use } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AppLoadContext, EntryContext } from 'react-router';

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
    {} as AppLoadContext
  ) as Promise<Response>;
}

describe('the Node entry', () => {
  it("is React Router's default entry.server.node.tsx, byte for byte", () => {
    const require = createRequire(import.meta.url);
    const defaults = require
      .resolve('@react-router/dev/package.json')
      .replace(/package\.json$/, 'dist/config/defaults/entry.server.node.tsx');
    const ours = readFileSync(new URL('../entry-server.node.tsx', import.meta.url), 'utf8');
    const theirs = readFileSync(defaults, 'utf8');
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
