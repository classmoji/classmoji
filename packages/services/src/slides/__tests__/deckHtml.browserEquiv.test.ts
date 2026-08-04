/**
 * htmlEquivalentModuloBrowserSerialization contract (Phase 7.5 phantom-
 * conflict fix).
 *
 * Positive cases are pinned by CAPTURED Chromium output (see
 * fixtures/browserSerialization.ts for provenance): the stored form of a
 * fragment, its pure innerHTML round-trip, and its CSSOM-restyled form must
 * all be equivalent. Negative cases prove the equivalence stays conservative:
 * genuinely different colors/numbers/text/code/attrs still differ.
 */

import { describe, expect, it } from 'vitest';
import { htmlEquivalentModuloBrowserSerialization as equivalent } from '../deckHtml.ts';
import {
  BROWSER_SERIALIZATION_FIXTURES,
  TRUE_DIFFERENCE_CASES,
} from './fixtures/browserSerialization.ts';

describe('htmlEquivalentModuloBrowserSerialization — captured browser rewrites are equal', () => {
  it.each(BROWSER_SERIALIZATION_FIXTURES)(
    '$name: input ≡ pure innerHTML round-trip',
    ({ input, roundtrip }) => {
      expect(equivalent(input, roundtrip)).toBe(true);
    }
  );

  it.each(BROWSER_SERIALIZATION_FIXTURES)(
    '$name: input ≡ CSSOM-restyled read-back',
    ({ input, cssom }) => {
      expect(equivalent(input, cssom)).toBe(true);
    }
  );

  it.each(BROWSER_SERIALIZATION_FIXTURES)(
    '$name: round-trip ≡ CSSOM form (transitivity across browser variants)',
    ({ roundtrip, cssom }) => {
      expect(equivalent(roundtrip, cssom)).toBe(true);
    }
  );
});

describe('htmlEquivalentModuloBrowserSerialization — genuine differences still differ', () => {
  it.each(TRUE_DIFFERENCE_CASES)('$name', ({ a, b }) => {
    expect(equivalent(a, b)).toBe(false);
    expect(equivalent(b, a)).toBe(false);
  });
});

describe('htmlEquivalentModuloBrowserSerialization — style declaration semantics', () => {
  it('declaration order is insignificant', () => {
    expect(
      equivalent(
        '<div style="color: red; top: 1px">x</div>',
        '<div style="top: 1px; color: red">x</div>'
      )
    ).toBe(true);
  });

  it('trailing semicolon and declaration spacing are insignificant', () => {
    expect(
      equivalent(
        '<div style="color:red;top:1px">x</div>',
        '<div style="color: red; top: 1px;">x</div>'
      )
    ).toBe(true);
  });

  it('duplicate properties resolve last-wins (browser behavior)', () => {
    expect(
      equivalent('<div style="color: red; color: blue">x</div>', '<div style="color: blue">x</div>')
    ).toBe(true);
    expect(
      equivalent('<div style="color: red; color: blue">x</div>', '<div style="color: red">x</div>')
    ).toBe(false);
  });

  it('4/8-digit hex (alpha) forms stay strict — never conflated with rgb()', () => {
    expect(
      equivalent(
        '<div style="color:#e07b39aa">x</div>',
        '<div style="color: rgb(224, 123, 57);">x</div>'
      )
    ).toBe(false);
  });

  it('named colors are never conflated with their rgb value (deliberately strict)', () => {
    expect(
      equivalent('<div style="color: red">x</div>', '<div style="color: rgb(255, 0, 0)">x</div>')
    ).toBe(false);
  });

  it('data-URL url() args with semicolons survive declaration splitting', () => {
    const dataUrl =
      '<div style="background: url(data:image/png;base64,AAAA); color:#ffffff">x</div>';
    const browserForm =
      '<div style="background: url(&quot;data:image/png;base64,AAAA&quot;); color: rgb(255, 255, 255);">x</div>';
    expect(equivalent(dataUrl, browserForm)).toBe(true);
    expect(
      equivalent(
        dataUrl,
        '<div style="background: url(&quot;data:image/png;base64,BBBB&quot;); color: rgb(255, 255, 255);">x</div>'
      )
    ).toBe(false);
  });
});

describe('htmlEquivalentModuloBrowserSerialization — field-level edges', () => {
  it('null/undefined equal each other but never a string (absent ≠ empty)', () => {
    expect(equivalent(null, undefined)).toBe(true);
    expect(equivalent(null, '')).toBe(false);
    expect(equivalent('', null)).toBe(false);
    expect(equivalent('', '')).toBe(true);
  });

  it('boolean attr forms are equal (data-x vs data-x="")', () => {
    expect(equivalent('<div data-x>x</div>', '<div data-x="">x</div>')).toBe(true);
    expect(equivalent('<div data-x>x</div>', '<div data-x="1">x</div>')).toBe(false);
  });

  it('attribute order is insignificant, attribute presence is not', () => {
    expect(equivalent('<div a="1" b="2">x</div>', '<div b="2" a="1">x</div>')).toBe(true);
    expect(equivalent('<div a="1" b="2">x</div>', '<div a="1">x</div>')).toBe(false);
  });

  it('inter-element whitespace text stays significant', () => {
    expect(equivalent('<p>a</p> <p>b</p>', '<p>a</p><p>b</p>')).toBe(false);
  });

  it('style attrs INSIDE pre/code get no loosening (code content is sacred)', () => {
    expect(
      equivalent(
        '<pre><code><span style="color:#e07b39">x</span></code></pre>',
        '<pre><code><span style="color: rgb(224, 123, 57);">x</span></code></pre>'
      )
    ).toBe(false);
  });

  it("the pre/code element's OWN chrome attrs still tolerate browser rewrites", () => {
    expect(
      equivalent(
        '<pre style="width:600.50px"><code class="language-js">x</code></pre>',
        '<pre style="width: 600.5px;"><code class="language-js">x</code></pre>'
      )
    ).toBe(true);
  });
});
