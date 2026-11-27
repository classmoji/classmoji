// @vitest-environment jsdom
/**
 * EditableCell, MOUNTED in jsdom: it saves (calls `onUpdate`) only a value
 * that differs from the record's, so opening a cell and leaving it without an
 * edit writes nothing (and so records no change in the audit log).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import EditableCell from '../EditableCell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onUpdate = vi.fn();

beforeEach(() => {
  onUpdate.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = async () => {
  await act(async () => {
    root.render(
      <EditableCell record={{ id: 'q1', title: 'Week 1' }} dataIndex="title" onUpdate={onUpdate} />
    );
  });
};

const open = async () => {
  await act(async () => {
    container.querySelector('button')!.click();
  });
};

const leave = async () => {
  const cell = container.querySelector('input')!.parentElement!.closest('div')!;
  await act(async () => {
    cell.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });
};

const type = async (value: string) => {
  const input = container.querySelector('input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const pressEnter = async () => {
  await act(async () => {
    container
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
};

describe('EditableCell', () => {
  it('leaving the cell without an edit saves nothing', async () => {
    await mount();
    await open();
    expect(container.querySelector('input')).not.toBeNull();
    await leave();
    expect(container.querySelector('input')).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('Enter on an unchanged value saves nothing', async () => {
    await mount();
    await open();
    await pressEnter();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('saves a changed value, once', async () => {
    await mount();
    await open();
    await type('Week 2');
    await pressEnter();
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith('q1', 'Week 2');
  });

  it('saves a changed value when the pointer leaves', async () => {
    await mount();
    await open();
    await type('Week 3');
    await leave();
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith('q1', 'Week 3');
  });
});
