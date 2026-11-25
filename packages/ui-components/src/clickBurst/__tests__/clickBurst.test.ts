// @vitest-environment jsdom
/**
 * The click burst (`clickBurst.ts`): which clicks are a control's
 * (`isBurstTarget`), and what the installed listener draws for them: one SVG
 * per click, none for a non-control, under reduced motion or without Web
 * Animations, one listener however often it is installed, none once the last
 * install is undone, at the pointer or (keyboard) the control's centre, in the
 * control's `--burst-color`. jsdom has no Web Animations: `animate` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BURST_CLASS, installClickBurst, isBurstTarget, playBurst } from '../clickBurst.ts';

const html = (markup: string) => {
  document.body.innerHTML = markup;
};
const $ = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
};
const bursts = () => [...document.querySelectorAll(`svg.${BURST_CLASS}`)] as SVGSVGElement[];
/** Bursts played so far, gone or not (four rays each). */
const played = () => vi.mocked(Element.prototype.animate).mock.calls.length / 4;

const reducedMotion = (reduce: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({
        matches: reduce && query.includes('reduce'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList
  );

beforeEach(() => {
  // jsdom has neither; a resolved `finished` lets the layer remove itself.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: false }),
  });
  Element.prototype.animate = vi.fn(
    () => ({ finished: Promise.resolve() }) as unknown as Animation
  ) as unknown as Element['animate'];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).animate;
  document.body.innerHTML = '';
});

describe('isBurstTarget', () => {
  it.each<[string, string, string]>([
    ['a button', '<button id="t">Go</button>', '#t'],
    ['a link', '<a id="t" href="/x">Go</a>', '#t'],
    ['a summary', '<details><summary id="t">More</summary></details>', '#t'],
    ['a checkbox', '<input id="t" type="checkbox">', '#t'],
    ['a radio', '<input id="t" type="radio">', '#t'],
    ['a submit input', '<input id="t" type="submit">', '#t'],
    ['a button input', '<input id="t" type="button">', '#t'],
    ['a reset input', '<input id="t" type="reset">', '#t'],
    ...[
      'button',
      'link',
      'checkbox',
      'switch',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'tab',
      'option',
      'radio',
      'treeitem',
    ].map((role): [string, string, string] => [
      `role=${role}`,
      `<div id="t" role="${role}">x</div>`,
      '#t',
    ]),
  ])('%s is its own control', (_name, markup, selector) => {
    html(markup);
    expect(isBurstTarget($(selector))).toBe($(selector));
  });

  it('a click inside a control is the control’s (an icon, a text node)', () => {
    html('<button id="t"><svg><path id="icon"></path></svg><span id="s">Go</span></button>');
    expect(isBurstTarget($('#icon'))).toBe($('#t'));
    expect(isBurstTarget($('#s').firstChild)).toBe($('#t'));
  });

  it('a label for a checkbox or radio is a control; one for a text field is not', () => {
    html(
      '<label id="for-box" for="box">Done</label><input id="box" type="checkbox">' +
        '<label id="wrap"><input type="radio"> Pick</label>' +
        '<label id="for-text" for="name">Name</label><input id="name">'
    );
    expect(isBurstTarget($('#for-box'))).toBe($('#for-box'));
    expect(isBurstTarget($('#wrap'))).toBe($('#wrap'));
    expect(isBurstTarget($('#for-text'))).toBeNull();
  });

  it.each([
    ['plain text', '<p id="t">Words</p>'],
    ['a div', '<div id="t">Box</div>'],
    ['a link without href', '<a id="t">Anchor</a>'],
    ['a disabled button', '<button id="t" disabled>Go</button>'],
    ['an aria-disabled control', '<div id="t" role="button" aria-disabled="true">Go</div>'],
    [
      'under an aria-disabled ancestor',
      '<div aria-disabled="true"><a id="t" href="/">Go</a></div>',
    ],
    ['in a disabled fieldset', '<fieldset disabled><button id="t">Go</button></fieldset>'],
    [
      'a label for a disabled checkbox',
      '<label id="t" for="box">Done</label><input id="box" type="checkbox" disabled>',
    ],
    ['in a contenteditable', '<div contenteditable="true"><button id="t">B</button></div>'],
    ['in a bare contenteditable', '<div contenteditable><a id="t" href="/">x</a></div>'],
    [
      'in a non-editable island of an editor',
      '<div contenteditable="true"><span contenteditable="false"><button id="t">x</button></span></div>',
    ],
    ['in a CodeMirror editor', '<div class="cm-editor"><button id="t">x</button></div>'],
    ['in a Monaco editor', '<div class="monaco-editor"><div id="t" role="button">x</div></div>'],
    ['a textarea', '<textarea id="t"></textarea>'],
    ['a text input', '<input id="t" type="text">'],
    ['an input with no type', '<input id="t">'],
    ['a select', '<select id="t"><option>a</option></select>'],
    [
      'an antd number input’s stepper',
      '<div class="ant-input-number"><span id="t" role="button">up</span><input></div>',
    ],
    ['a search input', '<input id="t" type="search">'],
    ['under data-no-burst', '<div data-no-burst><button id="t">Go</button></div>'],
    ['itself data-no-burst', '<button id="t" data-no-burst>Go</button>'],
  ])('%s is not', (_name, markup) => {
    html(markup);
    expect(isBurstTarget($('#t'))).toBeNull();
  });

  it('a disabled fieldset’s first legend stays enabled', () => {
    html('<fieldset disabled><legend><button id="t">Toggle</button></legend></fieldset>');
    expect(isBurstTarget($('#t'))).toBe($('#t'));
  });

  it('a read-only editor (contenteditable="false") keeps its controls', () => {
    html('<div contenteditable="false"><button id="t">Copy</button></div>');
    expect(isBurstTarget($('#t'))).toBe($('#t'));
  });

  it('nothing, or the document, is not a target', () => {
    expect(isBurstTarget(null)).toBeNull();
    expect(isBurstTarget(document)).toBeNull();
    expect(isBurstTarget(window)).toBeNull();
  });
});

const click = (target: Element, init: MouseEventInit = {}) =>
  target.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: 40,
      clientY: 50,
      ...init,
    })
  );

const at = (svg: SVGSVGElement) => ({
  left: parseFloat(svg.style.left),
  top: parseFloat(svg.style.top),
});

describe('installClickBurst', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('one burst per control click, centred on the pointer, four rays, inert', () => {
    html('<button id="t">Go</button>');
    uninstall = installClickBurst();
    click($('#t'));
    const [burst, ...more] = bursts();
    expect(more).toEqual([]);
    expect(burst.querySelectorAll('line')).toHaveLength(4);
    expect(burst.getAttribute('aria-hidden')).toBe('true');
    expect(burst.style.position).toBe('fixed');
    expect(burst.style.pointerEvents).toBe('none');
    // A 60px layer centred on (40, 50).
    expect(at(burst)).toEqual({ left: 10, top: 20 });
    click($('#t'));
    expect(bursts()).toHaveLength(2);
  });

  it('the layer goes once its rays are done', async () => {
    html('<button id="t">Go</button>');
    uninstall = installClickBurst();
    click($('#t'));
    expect(bursts()).toHaveLength(1);
    await vi.waitFor(() => expect(bursts()).toHaveLength(0));
  });

  it('a click that is not a control’s draws nothing', () => {
    html('<p id="t">Words</p><button disabled id="off">Go</button><textarea id="ta"></textarea>');
    uninstall = installClickBurst();
    click($('#t'));
    click($('#off'));
    click($('#ta'));
    expect(bursts()).toEqual([]);
  });

  it('a handler that stops the click does not stop the burst (capture phase)', () => {
    html('<div id="wrap"><button id="t">Go</button></div>');
    $('#wrap').addEventListener('click', event => event.stopPropagation());
    $('#t').addEventListener('click', event => event.stopImmediatePropagation());
    uninstall = installClickBurst();
    click($('#t'));
    expect(bursts()).toHaveLength(1);
  });

  it('reduced motion: nothing', () => {
    reducedMotion(true);
    html('<button id="t">Go</button>');
    uninstall = installClickBurst();
    click($('#t'));
    expect(bursts()).toEqual([]);
  });

  it('no Web Animations: nothing', () => {
    delete (Element.prototype as Partial<Element>).animate;
    html('<button id="t">Go</button>');
    uninstall = installClickBurst();
    click($('#t'));
    expect(bursts()).toEqual([]);
    expect(playBurst(1, 1, 'red')).toBeNull();
  });

  it('installing twice keeps one listener; the last uninstall removes it', () => {
    html('<button id="t">Go</button>');
    const first = installClickBurst();
    const second = installClickBurst();
    click($('#t'));
    expect(bursts()).toHaveLength(1);
    first();
    // Undoing the same install twice does not undo the other one.
    first();
    click($('#t'));
    expect(bursts()).toHaveLength(2);
    second();
    click($('#t'));
    expect(bursts()).toHaveLength(2);
    // And it installs again from scratch.
    uninstall = installClickBurst();
    click($('#t'));
    expect(bursts()).toHaveLength(3);
  });

  it('a keyboard click (detail 0) bursts at the control’s centre', () => {
    html('<button id="t">Go</button>');
    vi.spyOn($('#t'), 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 200, width: 80, height: 30 })
    );
    uninstall = installClickBurst();
    click($('#t'), { detail: 0, clientX: 0, clientY: 0 });
    const [burst] = bursts();
    // Centre (140, 215), less half the 60px layer.
    expect(at(burst)).toEqual({ left: 110, top: 185 });
  });

  it('a script’s click on a control that is not drawn (0×0) draws nothing', () => {
    html('<a id="t" href="/file.pdf" style="display:none">download</a>');
    $('#t').addEventListener('click', event => event.preventDefault());
    uninstall = installClickBurst();
    click($('#t'), { detail: 0, clientX: 0, clientY: 0 });
    expect(bursts()).toEqual([]);
  });

  it('a label click and the click it sends its checkbox burst once', async () => {
    html('<label id="t" for="box">Done</label><input id="box" type="checkbox">');
    // Drawn: jsdom's click on the box has no coordinates (the centre path).
    vi.spyOn($('#box'), 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 16, height: 16 })
    );
    uninstall = installClickBurst();
    // jsdom, like a browser, follows the label's click with one on the box.
    click($('#t'));
    expect(($('#box') as HTMLInputElement).checked).toBe(true);
    expect(played()).toBe(1);
    // The next click on the box itself is its own.
    await new Promise(resolve => setTimeout(resolve, 5));
    click($('#box'));
    expect(($('#box') as HTMLInputElement).checked).toBe(false);
    expect(played()).toBe(2);
  });

  it('drawn in the control’s --burst-color, else its text colour', () => {
    html(
      '<button id="token" style="--burst-color: rgb(1, 2, 3)">a</button>' +
        '<button id="plain" style="color: rgb(4, 5, 6)">b</button>'
    );
    uninstall = installClickBurst();
    click($('#token'));
    click($('#plain'));
    expect(bursts().map(svg => svg.style.color)).toEqual(['rgb(1, 2, 3)', 'rgb(4, 5, 6)']);
  });

  it('a drag (pointer moved more than 5 px since it went down) draws nothing', () => {
    html('<a id="t" href="#x">Grip</a>');
    $('#t').addEventListener('click', event => event.preventDefault());
    uninstall = installClickBurst();
    const down = (x: number, y: number) =>
      $('#t').dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })
      );
    down(10, 10);
    click($('#t'), { clientX: 40, clientY: 50 });
    expect(played()).toBe(0);
    // A press that wobbles a little is still a press.
    down(38, 47);
    click($('#t'), { clientX: 40, clientY: 50 });
    expect(played()).toBe(1);
    // A click with no pointerdown before it (another device) still bursts.
    click($('#t'), { clientX: 40, clientY: 50 });
    expect(played()).toBe(2);
  });

  it('Enter in a text field (the form’s implicit submit) draws nothing', () => {
    html('<form><input id="name"><button id="t" type="submit">Save</button></form>');
    $('form').addEventListener('submit', event => event.preventDefault());
    vi.spyOn($('#t'), 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 80, height: 30 })
    );
    uninstall = installClickBurst();
    ($('#name') as HTMLInputElement).focus();
    click($('#t'), { detail: 0, clientX: 0, clientY: 0 });
    expect(played()).toBe(0);
    // Space or Enter on the focused button itself still bursts.
    ($('#t') as HTMLButtonElement).focus();
    click($('#t'), { detail: 0, clientX: 0, clientY: 0 });
    expect(played()).toBe(1);
  });

  it('data-no-burst on <body> or <html> turns every burst off', () => {
    html('<button id="t">Go</button>');
    uninstall = installClickBurst();
    document.body.setAttribute('data-no-burst', '');
    click($('#t'));
    document.body.removeAttribute('data-no-burst');
    document.documentElement.setAttribute('data-no-burst', '');
    click($('#t'));
    document.documentElement.removeAttribute('data-no-burst');
    expect(played()).toBe(0);
    click($('#t'));
    expect(played()).toBe(1);
  });
});
