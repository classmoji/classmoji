/**
 * `RENDER_BUSY` (both render slots taken for 20 s) is load shedding the agent
 * is told to retry: it is never reported, though page_render and deck_render
 * carry it as the cause of their `internal` ToolError, which the registry
 * reports. The browser never opens here (its launch never settles), so the
 * two slots stay taken.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reportError,
  setErrorReporter,
  wasReported,
  type ReportContext,
} from '@classmoji/utils/error-report';

vi.mock('playwright-core', () => ({
  chromium: { launch: () => new Promise(() => {}), connectOverCDP: () => new Promise(() => {}) },
}));

const { RenderError, withRenderPage } = await import('../browser.ts');
const { ToolError } = await import('../../mcp/errors.ts');

afterEach(() => {
  setErrorReporter(null);
  vi.useRealTimers();
});

describe('RENDER_BUSY', () => {
  it('is marked reported when made, so no reporter ever sends it', async () => {
    vi.useFakeTimers();
    const captured: Array<{ error: unknown; context: ReportContext }> = [];
    setErrorReporter({
      capture: (error, context) => void captured.push({ error, context }),
      flush: async () => true,
    });
    const session = {
      width: 800,
      height: 600,
      origin: 'http://localhost',
      cookie: { name: 'v', value: 'x', url: 'http://localhost' },
    } as unknown as Parameters<typeof withRenderPage>[0];
    // Two renders take both slots and wait on the browser forever.
    void withRenderPage(session, async () => 'a');
    void withRenderPage(session, async () => 'b');
    const third = withRenderPage(session, async () => 'c').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_001);
    const busy = await third;

    expect(busy).toBeInstanceOf(RenderError);
    expect((busy as InstanceType<typeof RenderError>).code).toBe('RENDER_BUSY');
    expect(wasReported(busy)).toBe(true);
    // What the registry does with the tool's refusal: report its cause.
    const refusal = new ToolError('internal', 'busy', 'RENDER_BUSY', undefined, { cause: busy });
    reportError(refusal.cause ?? refusal, { surface: 'mcp.tool' });
    expect(captured).toEqual([]);
  });
});
