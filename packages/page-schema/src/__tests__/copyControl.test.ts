// @vitest-environment jsdom
/**
 * The copy control's DOM: the reader's Copy button and the editor's toggle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COPIED_MS,
  COPY_BUTTON_CLASS,
  COPY_TOGGLE_CLASS,
  createCopyButton,
  createCopyToggle,
  isCopyable,
  writeClipboardText,
} from '../copyControl.ts';

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('createCopyButton', () => {
  it('is an icon button named Copy that copies the text read at click time', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    let text = 'old';
    const button = createCopyButton(() => text);
    expect(button.className).toBe(COPY_BUTTON_CLASS);
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Copy');
    expect(button.title).toBe('Copy');
    expect(button.textContent).toBe('');
    expect(button.querySelectorAll('svg')).toHaveLength(2);

    vi.useFakeTimers();
    text = 'echo hi';
    button.click();
    await vi.waitFor(() => expect(button.hasAttribute('data-copied')).toBe(true));
    expect(writeText).toHaveBeenCalledWith('echo hi');
    vi.advanceTimersByTime(COPIED_MS);
    expect(button.hasAttribute('data-copied')).toBe(false);
  });

  it('a press does not move focus or selection', () => {
    const button = createCopyButton(() => '');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
});

describe('createCopyToggle', () => {
  it('shows the state in aria-pressed and the title, and calls back on click', () => {
    const onToggle = vi.fn();
    const on = createCopyToggle(true, onToggle);
    expect(on.className).toBe(COPY_TOGGLE_CLASS);
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.title).toBe('Copying allowed');
    on.click();
    expect(onToggle).toHaveBeenCalledTimes(1);

    const off = createCopyToggle(false, onToggle);
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(off.title).toBe('Copying disabled');
  });
});

describe('writeClipboardText', () => {
  it('falls back to execCommand when the Clipboard API is refused (a framed page)', async () => {
    stubClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    try {
      expect(await writeClipboardText('x')).toBe(true);
      expect(exec).toHaveBeenCalledWith('copy');
      // The helper textarea is gone again.
      expect(document.querySelector('textarea')).toBeNull();
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });
});

describe('isCopyable', () => {
  it('only false (or the string BlockNote would draw as data-copyable="false") turns it off', () => {
    expect(isCopyable({})).toBe(true);
    expect(isCopyable({ copyable: true })).toBe(true);
    expect(isCopyable({ copyable: false })).toBe(false);
    expect(isCopyable({ copyable: 'false' })).toBe(false);
    for (const odd of [null, 0, '', 'no', undefined])
      expect(isCopyable({ copyable: odd })).toBe(true);
  });
});

describe('title-bar buttons and the editor', () => {
  it('Enter, Space and presses stay with the button; Enter still clicks it', () => {
    const onToggle = vi.fn();
    const host = document.createElement('div');
    const editorKeys = vi.fn();
    host.addEventListener('keydown', editorKeys);
    host.addEventListener('keyup', editorKeys);
    host.addEventListener('mousedown', editorKeys);
    const toggle = createCopyToggle(true, onToggle);
    host.appendChild(toggle);
    document.body.appendChild(host);
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    toggle.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    toggle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(editorKeys).not.toHaveBeenCalled();
    expect(toggle.getAttribute('aria-label')).toBe('Allow copying');
    host.remove();
  });
});
