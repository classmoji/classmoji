/**
 * The page content check's loader: a validator that cannot be loaded is a
 * coded error (nothing is ever written unchecked), and the failure is not
 * cached, so the next call loads it again.
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fail: true }));

vi.mock('@classmoji/page-schema/server', async () => {
  if (state.fail) throw new Error('module failed to load');
  return vi.importActual('@classmoji/page-schema/server');
});

describe('the content check loader', () => {
  it('fails closed with a code, then loads on a later call', async () => {
    const { pageContentProblems } = await import('../pageContentRules.ts');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(pageContentProblems([])).rejects.toMatchObject({
      kind: 'internal',
      code: 'CONTENT_CHECK_UNAVAILABLE',
    });

    state.fail = false;
    vi.resetModules();
    const bad = [
      {
        id: 'p1',
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', styles: { code: true, bold: true } }],
      },
    ];
    await expect(pageContentProblems(bad)).resolves.toEqual([
      expect.objectContaining({ blockId: 'p1', problem: "inline code can't also be bold" }),
    ]);
  });
});
