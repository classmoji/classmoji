// @vitest-environment jsdom
/**
 * The new-team modal's Tags field, MOUNTED in jsdom.
 *
 * Pinned here:
 *   - Create with no tag chosen submits nothing and shows the field's fixed
 *     error, next to the name's;
 *   - a tag made from the list's footer is selected straight away, and Create
 *     then submits it;
 *   - the footer input: Enter posts the new name to ?/createTag, and Backspace
 *     does not reach the Select (in multiple mode the Select takes Backspace on
 *     an empty search as "remove the last chosen tag").
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TagFetcher = {
  state: 'idle' | 'submitting' | 'loading';
  data: { tag?: { id: string; name: string }; error?: string } | undefined;
  submit: ReturnType<typeof vi.fn>;
};

const h = vi.hoisted(() => ({
  submit: vi.fn(),
  notify: vi.fn(),
  tagSubmit: vi.fn(),
  tagFetcher: null as unknown as TagFetcher,
}));

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => vi.fn(),
  useFetcher: () => h.tagFetcher,
}));
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({
    fetcher: { submit: h.submit, state: 'idle', data: undefined },
    notify: h.notify,
  }),
  useDisclosure: () => ({ show: vi.fn(), close: vi.fn(), visible: true }),
}));
vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {},
  TeamServiceError: class extends Error {},
}));

// antd's Form.Item lays out with Row/Col, whose responsive observer needs it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
// The modal's scroll lock measures the scrollbar through a pseudo-element,
// which jsdom does not implement; the element's own style is enough here.
const getStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (elt: Element) => getStyle(elt);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: AdminNewTeam } = await import('../admin.$class.teams.new/route.tsx');

const TAGS = [{ id: 'tag-1', name: 'Section A' }];

let container: HTMLDivElement;
let root: Root;

const render = async () => {
  await act(async () => {
    root.render(
      <AdminNewTeam
        {...({ loaderData: { tags: TAGS } } as unknown as Parameters<typeof AdminNewTeam>[0])}
      />
    );
  });
};

const createButton = () =>
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Create')!;
const errors = () =>
  [...document.querySelectorAll('.ant-form-item-explain-error')].map(n => n.textContent);
const chosenTags = () =>
  [...document.querySelectorAll('.ant-select-selection-item')].map(n => n.textContent);

const typeInto = async (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const openTagList = async () => {
  const selector = document.querySelector('[data-tour="teams-new-tags"] .ant-select-selector')!;
  await act(async () => {
    selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  return document.querySelector<HTMLInputElement>('input[aria-label="New team tag name"]')!;
};

const key = async (input: HTMLInputElement, name: string) => {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
};

beforeEach(() => {
  h.submit.mockReset();
  h.notify.mockReset();
  h.tagSubmit.mockReset();
  h.tagFetcher = { state: 'idle', data: undefined, submit: h.tagSubmit };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('new team modal: Tags', () => {
  it('refuses Create without a tag and says so', async () => {
    await render();
    await typeInto(document.querySelector('input[data-tour="teams-new-name"]')!, 'Red');

    await click(createButton());

    expect(h.submit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(errors()).toEqual(['At least one tag is required']));
  });

  it('shows both errors when name and tags are missing', async () => {
    await render();

    await click(createButton());

    expect(h.submit).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(errors()).toEqual(['Team name is required', 'At least one tag is required'])
    );
  });

  it('selects a tag made from the footer, then creates the team with it', async () => {
    await render();
    await typeInto(document.querySelector('input[data-tour="teams-new-name"]')!, 'Red');
    await click(createButton());
    await vi.waitFor(() => expect(errors()).toEqual(['At least one tag is required']));

    // The tag fetcher comes back with the new tag.
    h.tagFetcher = {
      state: 'idle',
      data: { tag: { id: 'tag-new', name: 'Projects' } },
      submit: h.tagSubmit,
    };
    await render();

    expect(chosenTags()).toEqual(['Projects']);
    await vi.waitFor(() => expect(errors()).toEqual([]));

    await click(createButton());

    expect(h.submit).toHaveBeenCalledExactlyOnceWith(
      { name: 'Red', tags: ['tag-new'], visibility: 'closed' },
      { method: 'post', encType: 'application/json', action: '?/createTeam' }
    );
  });

  it('shows a failed tag create on the field', async () => {
    h.tagFetcher = {
      state: 'idle',
      data: { error: 'Could not create the tag.' },
      submit: h.tagSubmit,
    };
    await render();

    await vi.waitFor(() => expect(errors()).toEqual(['Could not create the tag.']));
  });

  it('posts the footer name on Enter, and keeps chosen tags on Backspace', async () => {
    h.tagFetcher = {
      state: 'idle',
      data: { tag: { id: 'tag-1', name: 'Section A' } },
      submit: h.tagSubmit,
    };
    await render();
    expect(chosenTags()).toEqual(['Section A']);

    const input = await openTagList();
    expect(input).not.toBeNull();

    await key(input, 'Backspace');
    expect(chosenTags()).toEqual(['Section A']);

    await typeInto(input, '  Projects ');
    await key(input, 'Enter');

    expect(h.tagSubmit).toHaveBeenCalledExactlyOnceWith(
      { name: 'Projects' },
      { method: 'post', encType: 'application/json', action: '?/createTag' }
    );
    expect(h.submit).not.toHaveBeenCalled();
  });
});
