/**
 * The Cloudinary URL parser against the shapes our code actually stored
 * (plan §13.4), the other forms of the same asset a person could paste, and
 * the contexts decks hold them in — `<video src>`, a slides.com
 * `data-background-video` value (HTML and deck.json attrs), JSON strings.
 */

import { describe, expect, it } from 'vitest';

import {
  findCloudinaryCandidates,
  parseCloudinaryUrl,
  parseUploadPath,
  rewriteText,
  candidatePublicIds,
  scanText,
} from '../cloudinaryUrls.ts';

const CLOUD = 'classmoji-test';
const SLIDE = '0b0c1d2e-3f40-4152-8637-48495a6b7c8d';
const RANDOM_ID = `classmoji/slides/${SLIDE}/qz1xk4abcd9`;
const NAMED_ID = `classmoji/slides/${SLIDE}/it's (final) v2, a+b`;

/** Exactly what `cld.url(id, { resource_type: 'video', secure: true, transformation: [{ quality: 'auto', fetch_format: 'auto' }] })` produced on cloudinary 2.9.0. */
const SDK_RANDOM = `https://res.cloudinary.com/${CLOUD}/video/upload/f_auto,q_auto/v1/${RANDOM_ID}?_a=BAMAOGfm0`;
const SDK_NAMED = `https://res.cloudinary.com/${CLOUD}/video/upload/f_auto,q_auto/v1/classmoji/slides/${SLIDE}/it's%20(final)%20v2%2C%20a%2Bb?_a=BAMAOGfm0`;

const KNOWN = new Set([RANDOM_ID, NAMED_ID]);

describe('parseUploadPath / parseCloudinaryUrl', () => {
  it('maps the SDK URL (sorted f_auto,q_auto, literal v1, no extension, _a query) to its public_id', () => {
    expect(parseCloudinaryUrl(SDK_RANDOM, CLOUD)).toMatchObject({
      publicId: RANDOM_ID,
      ext: null,
      still: false,
    });
  });

  it('decodes a percent-encoded tail and keeps the raw characters the SDK leaves', () => {
    expect(parseCloudinaryUrl(SDK_NAMED, CLOUD)?.publicId).toBe(NAMED_ID);
  });

  it.each([
    ['no query', `https://res.cloudinary.com/${CLOUD}/video/upload/f_auto,q_auto/v1/${RANDOM_ID}`],
    [
      'real version',
      `https://res.cloudinary.com/${CLOUD}/video/upload/v1720618130/${RANDOM_ID}.mp4`,
    ],
    ['no version, no transform', `https://res.cloudinary.com/${CLOUD}/video/upload/${RANDOM_ID}`],
    ['http', `http://res.cloudinary.com/${CLOUD}/video/upload/q_auto/${RANDOM_ID}.webm`],
    [
      'chained transforms',
      `https://res.cloudinary.com/${CLOUD}/video/upload/c_scale,w_640/so_2.5/v3/${RANDOM_ID}`,
    ],
    ['signed', `https://res.cloudinary.com/${CLOUD}/video/upload/s--AbCdEf12--/v1/${RANDOM_ID}`],
    ['protocol-relative', `//res.cloudinary.com/${CLOUD}/video/upload/v1/${RANDOM_ID}`],
    ['fragment', `https://res.cloudinary.com/${CLOUD}/video/upload/v1/${RANDOM_ID}#t=5`],
  ])('accepts %s', (_label, url) => {
    expect(parseCloudinaryUrl(url, CLOUD)?.publicId).toBe(RANDOM_ID);
  });

  it('classifies a still frame of the video as a still', () => {
    const parsed = parseUploadPath(`so_1/v1/${RANDOM_ID}.jpg`);
    expect(parsed).toMatchObject({ publicId: RANDOM_ID, ext: 'jpg', still: true });
  });

  it('refuses another cloud, image resources and non-Cloudinary hosts', () => {
    expect(parseCloudinaryUrl(SDK_RANDOM.replace(CLOUD, 'someone-else'), CLOUD)).toBeNull();
    expect(
      parseCloudinaryUrl(`https://res.cloudinary.com/${CLOUD}/image/upload/v1/${RANDOM_ID}`, CLOUD)
    ).toBeNull();
    expect(parseCloudinaryUrl(`https://example.com/${CLOUD}/video/upload/v1/x`, CLOUD)).toBeNull();
  });
});

describe('scanText', () => {
  it('finds the SDK URL in a <video src> and resolves it whole, query included', () => {
    const html = `<video src="${SDK_RANDOM}" controls></video>`;
    const [ref] = scanText(html, CLOUD, KNOWN);
    expect(ref).toMatchObject({
      kind: 'video',
      publicId: RANDOM_ID,
      raw: SDK_RANDOM,
      context: 'other',
    });
  });

  it('takes a data-background-video value whole, not split at the transformation comma', () => {
    const html = `<section data-background-video="${SDK_RANDOM}" data-background-video-loop>`;
    const refs = scanText(html, CLOUD, KNOWN);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'video', raw: SDK_RANDOM, context: 'background' });
  });

  it('finds a deck.json attrs entry for data-background-video as background', () => {
    const json = JSON.stringify({ attrs: { 'data-background-video': SDK_RANDOM } });
    const [ref] = scanText(json, CLOUD, KNOWN);
    expect(ref).toMatchObject({ kind: 'video', raw: SDK_RANDOM, context: 'background' });
  });

  it('finds a background value inside HTML held in a JSON string (escaped quotes)', () => {
    const json = JSON.stringify({
      html: `<section data-background-video="${SDK_RANDOM}"></section>`,
    });
    const [ref] = scanText(json, CLOUD, KNOWN);
    expect(ref).toMatchObject({ kind: 'video', raw: SDK_RANDOM, context: 'background' });
  });

  it('stops at a comma that starts the next source in a list', () => {
    const other = `https://res.cloudinary.com/${CLOUD}/video/upload/v1/${NAMED_ID.replace(/ /g, '%20')}`;
    const html = `<section data-background-video="${SDK_RANDOM},${other}">`;
    const refs = findCloudinaryCandidates(html, CLOUD);
    expect(refs.map(ref => ref.raw)).toEqual([SDK_RANDOM, other]);
  });

  it('cuts a raw apostrophe or paren back only as far as a listed asset allows', () => {
    const singleQuoted = `<video src='${SDK_NAMED}'></video>`;
    const [ref] = scanText(singleQuoted, CLOUD, KNOWN);
    expect(ref).toMatchObject({ kind: 'video', publicId: NAMED_ID });

    const cssUrl = `background: url(https://res.cloudinary.com/${CLOUD}/video/upload/v1/${RANDOM_ID}.mp4);`;
    const [css] = scanText(cssUrl, CLOUD, KNOWN);
    expect(css).toMatchObject({ kind: 'video', publicId: RANDOM_ID });
    expect(css?.raw.endsWith('.mp4')).toBe(true);
  });

  it('drops trailing prose punctuation and an HTML-escaped quote', () => {
    const prose = `See https://res.cloudinary.com/${CLOUD}/video/upload/v1/${RANDOM_ID}. Then`;
    expect(scanText(prose, CLOUD, KNOWN)[0]).toMatchObject({ kind: 'video', publicId: RANDOM_ID });
    const escaped = `data-x=&quot;https://res.cloudinary.com/${CLOUD}/video/upload/v1/${RANDOM_ID}&quot;`;
    expect(scanText(escaped, CLOUD, KNOWN)[0]).toMatchObject({
      kind: 'video',
      publicId: RANDOM_ID,
    });
  });

  it('reports stills and unlisted public_ids without resolving them to a video', () => {
    const text = [
      `<img src="https://res.cloudinary.com/${CLOUD}/video/upload/so_1/v1/${RANDOM_ID}.jpg">`,
      `<video src="https://res.cloudinary.com/${CLOUD}/video/upload/v1/classmoji/slides/x/gone"></video>`,
    ].join('\n');
    const refs = scanText(text, CLOUD, KNOWN);
    expect(refs.map(ref => ref.kind)).toEqual(['still', 'unknown']);
    expect(refs[1]).toMatchObject({ guess: 'classmoji/slides/x/gone' });
  });

  it('ignores other clouds entirely', () => {
    expect(scanText(SDK_RANDOM.replace(CLOUD, 'demo'), CLOUD, KNOWN)).toEqual([]);
  });
});

describe('the extension is a delivery format, not part of the public_id', () => {
  const TEAM = 'cs52-projects/team-a';
  const mp4 = `https://res.cloudinary.com/${CLOUD}/video/upload/q_auto/v1712345678/${TEAM}.mp4`;
  const mov = `https://res.cloudinary.com/${CLOUD}/video/upload/v1712345678/${TEAM}.mov`;

  it('offers the id without the extension first, then with it, deduplicated', () => {
    expect(candidatePublicIds({ raw: mp4 })).toEqual([TEAM, `${TEAM}.mp4`]);
    expect(candidatePublicIds({ raw: `${mov}?_a=x` })).toEqual([TEAM, `${TEAM}.mov`]);
    expect(candidatePublicIds({ raw: SDK_RANDOM })).toEqual([RANDOM_ID]);
  });

  it('maps .mp4 and .mov of one public_id to one asset and rewrites both', () => {
    const known = new Set([TEAM]);
    const text = `<video src="${mp4}"></video><video src="${mov}"></video>`;
    expect(
      scanText(text, CLOUD, known).map(ref => [ref.kind, 'publicId' in ref && ref.publicId])
    ).toEqual([
      ['video', TEAM],
      ['video', TEAM],
    ]);
    const out = rewriteText(text, CLOUD, known, new Map([[TEAM, 'media://m1']]));
    expect(out).toEqual({
      text: '<video src="media://m1"></video><video src="media://m1"></video>',
      replaced: 2,
    });
  });

  it('prefers a public_id that itself ends in the extension only when that is the known one', () => {
    const dotted = new Set([`${TEAM}.mp4`]);
    const [ref] = scanText(`<video src="${mp4}">`, CLOUD, dotted);
    expect(ref).toMatchObject({ kind: 'video', publicId: `${TEAM}.mp4` });
  });
});

describe('rewriteText stops at the markup after a query or fragment', () => {
  const map = new Map([[RANDOM_ID, 'media://AAA']]);
  const base = `https://res.cloudinary.com/${CLOUD}/video/upload/f_auto,q_auto/v1/${RANDOM_ID}`;
  const rewrite = (text: string) => rewriteText(text, CLOUD, KNOWN, map).text;

  it.each([
    ['a markdown link', `[watch](${base}?_a=X) and more`, '[watch](media://AAA) and more'],
    [
      'a CSS url() with escaped quotes',
      `url(&quot;${base}?_a=X&quot;)`,
      'url(&quot;media://AAA&quot;)',
    ],
    ['a fragment in parens', `(${base}.mp4#t=10)`, '(media://AAA)'],
    ['&#39; after a query', `x=&#39;${base}?_a=X&#39;`, 'x=&#39;media://AAA&#39;'],
    ['&apos; after a fragment', `&apos;${base}#t=1&apos;`, '&apos;media://AAA&apos;'],
    ['a single-quoted attribute', `<video src='${base}?_a=X'>`, "<video src='media://AAA'>"],
    ['a query followed by a space', `${base}?_a=X next`, 'media://AAA next'],
  ])('%s', (_label, input, expected) => {
    expect(rewrite(input)).toBe(expected);
  });

  it('keeps &amp; between query parameters inside the URL', () => {
    expect(rewrite(`<video src="${base}?_a=X&amp;b=2">`)).toBe('<video src="media://AAA">');
  });
});

describe('rewriteText', () => {
  const replacements = new Map([[RANDOM_ID, 'media://11111111-2222-5333-8444-555555555555']]);

  it('rewrites a src and a background value to media:// and leaves everything else', () => {
    const html =
      `<section data-background-video="${SDK_RANDOM}"><video src="${SDK_RANDOM}"></video>` +
      `<video src="${SDK_NAMED}"></video></section>`;
    const out = rewriteText(html, CLOUD, KNOWN, replacements);
    expect(out.replaced).toBe(2);
    expect(out.text).toBe(
      `<section data-background-video="media://11111111-2222-5333-8444-555555555555">` +
        `<video src="media://11111111-2222-5333-8444-555555555555"></video>` +
        `<video src="${SDK_NAMED}"></video></section>`
    );
  });

  it('rewrites a deck.json attrs value and keeps the JSON valid', () => {
    const json = JSON.stringify({ attrs: { 'data-background-video': SDK_RANDOM }, n: 1 });
    const out = rewriteText(json, CLOUD, KNOWN, replacements);
    expect(JSON.parse(out.text)).toEqual({
      attrs: { 'data-background-video': 'media://11111111-2222-5333-8444-555555555555' },
      n: 1,
    });
  });

  it('never rewrites a URL that merely starts with a migrated one', () => {
    const longer = `https://res.cloudinary.com/${CLOUD}/video/upload/v1/${RANDOM_ID}-extra`;
    const out = rewriteText(`<video src="${longer}">`, CLOUD, KNOWN, replacements);
    expect(out.replaced).toBe(0);
  });

  it('never rewrites a still', () => {
    const still = `https://res.cloudinary.com/${CLOUD}/video/upload/v1/${RANDOM_ID}.jpg`;
    expect(rewriteText(`<img src="${still}">`, CLOUD, KNOWN, replacements).replaced).toBe(0);
  });
});
