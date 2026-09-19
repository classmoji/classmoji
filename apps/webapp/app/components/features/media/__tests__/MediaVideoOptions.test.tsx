/**
 * The options block, asserted against the markup it renders.
 *
 * Two claims a pure-logic test cannot make: that a pdf gets no options area at
 * all rather than an empty one, and that a locked "Keep the original" is drawn
 * ticked AND disabled — a box that merely refused to change when clicked would
 * pass every reducer test and still read as "your original is being deleted".
 *
 * `renderToStaticMarkup` in the ordinary node-environment suite, matching the
 * other component tests here; the component is controlled, so every state worth
 * asserting is reachable by passing it in.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MediaVideoOptions from '../MediaVideoOptions';
import { DEFAULT_VIDEO_OPTIONS, applyVideoOption } from '../mediaUploadOptions';

const render = (filename: string, value = DEFAULT_VIDEO_OPTIONS, disabled = false) =>
  renderToStaticMarkup(
    <MediaVideoOptions filename={filename} value={value} disabled={disabled} onChange={() => {}} />
  );

/** The `<input>` tag for one option, so its attributes can be read. */
const inputFor = (html: string, id: string) =>
  html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';

describe('which options are shown', () => {
  it('gives a video exactly the three checkboxes from the plan', () => {
    const html = render('lecture.mp4');

    expect(html).toContain('Optimise for streaming');
    expect(html).toContain('Keep the original');
    expect(html).toContain('Allow download');
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
  });

  it.each(['syllabus.pdf', 'starter.zip', 'podcast.mp3', 'diagram.png'])(
    'gives %s no options area at all',
    filename => {
      expect(render(filename)).toBe('');
    }
  );

  it('explains each one in a line, since there is no second chance to set them', () => {
    const html = render('lecture.mp4');

    expect(html).toContain('works in every browser');
    expect(html).toContain('count towards your storage');
    expect(html).toContain('Teaching staff can always download');
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

  it('draws the original as kept AND locked once optimising is off', () => {
    const input = inputFor(render('lecture.mp4', unoptimised), 'media-keep-original');

    expect(input).toContain('checked');
    expect(input).toContain('disabled');
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
