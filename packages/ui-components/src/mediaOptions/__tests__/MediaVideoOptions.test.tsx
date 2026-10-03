/**
 * The options block, asserted against the markup it renders.
 *
 * Claims a pure-logic test cannot make: that a locked "Keep the original" is
 * drawn ticked AND disabled — a box that merely refused to change when clicked
 * would pass every reducer test and still read as "your original is being
 * deleted" — and that the copy says what each box does in the words the
 * uploader reads.
 *
 * `renderToStaticMarkup` in this package's node-environment suite; the
 * component is controlled, so every state worth asserting is reachable by
 * passing it in.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MediaVideoOptions from '../MediaVideoOptions.tsx';
import { DEFAULT_VIDEO_OPTIONS, applyVideoOption, type VideoOptions } from '../videoOptions.ts';

const render = (
  filename: string,
  value: VideoOptions = DEFAULT_VIDEO_OPTIONS,
  disabled = false,
  idPrefix?: string
) =>
  renderToStaticMarkup(
    <MediaVideoOptions
      filename={filename}
      value={value}
      disabled={disabled}
      onChange={() => {}}
      idPrefix={idPrefix}
    />
  );

/** The `<input>` tag for one option, so its attributes can be read. */
const inputFor = (html: string, id: string) =>
  html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';

describe('the three options', () => {
  it('draws exactly the three checkboxes from the plan', () => {
    const html = render('lecture.mp4');

    expect(html).toContain('Optimise for streaming');
    expect(html).toContain('Keep the original');
    expect(html).toContain('Allow download');
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
  });

  it('says what each one does, in the uploader’s words', () => {
    const html = render('lecture.mp4');

    expect(html).toContain('Converts it to a format that plays in every browser.');
    expect(html).toContain(
      'Also store the file you uploaded. Only the original counts toward storage.'
    );
    expect(html).toContain('Show students a download button.');
  });

  it('narrates no mechanics', () => {
    const html = render('lecture.mp4');

    expect(html).not.toContain('in the background');
    expect(html).not.toContain('straight away');
  });

  it('takes an id prefix, for a page with two of these', () => {
    const html = render('lecture.mp4', DEFAULT_VIDEO_OPTIONS, false, 'deck');
    expect(inputFor(html, 'deck-optimise')).not.toBe('');
    expect(inputFor(html, 'media-optimise')).toBe('');
  });
});

describe('the defaults, as drawn', () => {
  it('opens optimised, keeping the original, with download off', () => {
    const html = render('lecture.mp4');

    expect(inputFor(html, 'media-optimise')).toContain('checked');
    expect(inputFor(html, 'media-keep-original')).toContain('checked');
    expect(inputFor(html, 'media-allow-download')).not.toContain('checked');
  });

  it('leaves "Keep the original" free to be unticked while optimising is on', () => {
    expect(inputFor(render('lecture.mp4'), 'media-keep-original')).not.toContain('disabled');
  });
});

describe('the Keep-the-original coupling', () => {
  const unoptimised = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'optimise', false);

  it('draws the original as kept AND locked once optimising is off, and says why', () => {
    const html = render('lecture.mp4', unoptimised);
    const input = inputFor(html, 'media-keep-original');

    expect(input).toContain('checked');
    expect(input).toContain('disabled');
    expect(html).toContain('Without optimising, the file you uploaded is the only copy.');
  });

  it('re-locks the box even if the original had been dropped first', () => {
    const dropped = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'keepOriginal', false);
    const thenUnoptimised = applyVideoOption(dropped, 'optimise', false);
    const input = inputFor(render('lecture.mp4', thenUnoptimised), 'media-keep-original');

    expect(input).toContain('checked');
    expect(input).toContain('disabled');
  });

  it('warns about a .mov that will be served untouched, and only then', () => {
    const warning = 'May not play in Firefox or on Windows without optimising.';

    expect(render('screen.mov', unoptimised)).toContain(warning);
    expect(render('screen.mov')).not.toContain(warning);
    expect(render('lecture.mp4', unoptimised)).not.toContain(warning);
  });
});

describe('while an upload is running', () => {
  it('locks every box, so the options cannot change under the bytes in flight', () => {
    const html = render('lecture.mp4', DEFAULT_VIDEO_OPTIONS, true);

    for (const id of ['media-optimise', 'media-keep-original', 'media-allow-download']) {
      expect(inputFor(html, id)).toContain('disabled');
    }
  });
});
