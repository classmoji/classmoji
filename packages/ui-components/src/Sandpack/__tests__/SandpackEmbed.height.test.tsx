// @vitest-environment jsdom
/**
 * SandpackEmbed's `height` against a fake Sandpack: changing it (the quiz
 * sandbox's Expand / Collapse) only restyles the layout. The provider stays
 * mounted and keeps the very `files` object it was given, so Sandpack never
 * resets the student's edits or restarts its bundler.
 */

import { act, useEffect, type CSSProperties, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  providerMounts: 0,
  providerUnmounts: 0,
  filesSeen: [] as unknown[],
  layoutHeight: undefined as CSSProperties['height'],
}));

vi.mock('@codesandbox/sandpack-react', () => ({
  SandpackProvider: ({ files, children }: { files: unknown; children?: ReactNode }) => {
    fake.filesSeen.push(files);
    useEffect(() => {
      fake.providerMounts++;
      return () => {
        fake.providerUnmounts++;
      };
    }, []);
    return <>{children}</>;
  },
  SandpackLayout: ({ style, children }: { style?: CSSProperties; children?: ReactNode }) => {
    fake.layoutHeight = style?.height;
    return <div data-testid="layout">{children}</div>;
  },
  SandpackCodeEditor: () => null,
  SandpackPreview: () => null,
  useSandpack: () => ({ sandpack: { files: {} } }),
  useSandpackConsole: () => ({ logs: [] }),
}));

const { default: SandpackEmbed } = await import('../SandpackEmbed.tsx');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILES = { '/index.js': "console.log('hi');" };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.assign(fake, {
    providerMounts: 0,
    providerUnmounts: 0,
    filesSeen: [],
    layoutHeight: undefined,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('SandpackEmbed height', () => {
  it('restyles the layout without remounting the provider or resetting its files', async () => {
    const render = (height: number) =>
      act(async () => {
        root.render(<SandpackEmbed template="vanilla" files={FILES} height={height} />);
      });

    await render(320);
    expect(fake.layoutHeight).toBe(320);
    await render(640);
    expect(fake.layoutHeight).toBe(640);
    await render(320);
    expect(fake.layoutHeight).toBe(320);

    expect(fake.providerMounts).toBe(1);
    expect(fake.providerUnmounts).toBe(0);
    // One files object across every render: Sandpack resets on a new one.
    expect(new Set(fake.filesSeen).size).toBe(1);
  });
});
