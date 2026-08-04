/**
 * Browser-serialization ground truth for the editor-save merge equivalence
 * (Phase 7.5 phantom-conflict fix).
 *
 * PROVENANCE: every `roundtrip`/`cssom` string below was captured verbatim
 * from headless Chromium (Playwright 1.58.2 bundled chromium headless shell,
 * build 1208) on 2026-08-04 by a scratch script that, for each `input`:
 *
 *   1. `div.innerHTML = input; roundtrip = div.innerHTML`
 *      — the pure parse/serialize round-trip every posted slide goes through.
 *   2. then `el.setAttribute('style', el.style.cssText)` for every `[style]`
 *      element and read `div.innerHTML` again → `cssom`
 *      — what the style attribute becomes after ANY CSSOM style mutation
 *        (the Reveal editor mutates styles constantly: drag-positioning
 *        sl-blocks, visibility toggles, …), which re-serializes the whole
 *        declaration block in the browser's canonical form.
 *
 * Do not hand-edit the output strings — they are evidence, not style. If a
 * future Chromium changes its serialization, re-capture rather than tweak.
 *
 * What the capture demonstrates:
 * - pure round-trips keep style attrs byte-identical but rewrite valueless
 *   attrs (`data-x` → `data-x=""`), re-quote single-quoted attrs, re-encode
 *   entities (`&quot;` in text becomes `"` — including inside pre/code), and
 *   drop self-closing slashes (`<br/>` → `<br>`);
 * - CSSOM serialization converts 3/6-digit hex colors to `rgb(r, g, b)`
 *   (named colors stay named), respaces `rgb(a,b,c)` to `rgb(a, b, c)`,
 *   trims numeric noise (`600.50px` → `600.5px`, `.5px` → `0.5px`,
 *   `-50.0%` → `-50%`), quotes url() args (`url(x)` → `url("x")`), double-
 *   quotes font names, joins declarations with `; ` and a trailing `;`.
 */

export interface BrowserSerializationFixture {
  name: string;
  /** The markup as authored / stored in deck.json (generator-clean form). */
  input: string;
  /** Chromium's `div.innerHTML` read-back of `input` (pure round-trip). */
  roundtrip: string;
  /** Read-back after every `[style]` attr was re-serialized through the CSSOM. */
  cssom: string;
}

export const BROWSER_SERIALIZATION_FIXTURES: BrowserSerializationFixture[] = [
  {
    name: 'hex-color-style',
    input: '<h2 style="color:#e07b39">Warm heading</h2><p style="color: #AB47BC;">purple</p>',
    roundtrip: '<h2 style="color:#e07b39">Warm heading</h2><p style="color: #AB47BC;">purple</p>',
    cssom:
      '<h2 style="color: rgb(224, 123, 57);">Warm heading</h2><p style="color: rgb(171, 71, 188);">purple</p>',
  },
  {
    name: 'named-color-and-hex-bg',
    input: '<span style="color: red; background-color:#FF5500">x</span>',
    roundtrip: '<span style="color: red; background-color:#FF5500">x</span>',
    cssom: '<span style="color: red; background-color: rgb(255, 85, 0);">x</span>',
  },
  {
    name: 'sl-block-positioned-decimals',
    input:
      '<div class="sl-block" data-block-type="text" style="height: auto; width: 600.50px; left: 79.375px; top: .5px; z-index: 11"><div class="sl-block-content" style="text-align: left; font-size: 120%;"><p>Positioned</p></div></div>',
    roundtrip:
      '<div class="sl-block" data-block-type="text" style="height: auto; width: 600.50px; left: 79.375px; top: .5px; z-index: 11"><div class="sl-block-content" style="text-align: left; font-size: 120%;"><p>Positioned</p></div></div>',
    cssom:
      '<div class="sl-block" data-block-type="text" style="height: auto; width: 600.5px; left: 79.375px; top: 0.5px; z-index: 11;"><div class="sl-block-content" style="text-align: left; font-size: 120%;"><p>Positioned</p></div></div>',
  },
  {
    name: 'rgb-no-spaces',
    input: '<p style="color:rgb(224,123,57)">already rgb</p>',
    roundtrip: '<p style="color:rgb(224,123,57)">already rgb</p>',
    cssom: '<p style="color: rgb(224, 123, 57);">already rgb</p>',
  },
  {
    name: 'transform-decimals',
    input: '<div style="transform: translate(-50.0%, 20.25px) rotate(0.50deg);">t</div>',
    roundtrip: '<div style="transform: translate(-50.0%, 20.25px) rotate(0.50deg);">t</div>',
    cssom: '<div style="transform: translate(-50%, 20.25px) rotate(0.5deg);">t</div>',
  },
  {
    name: 'url-unquoted',
    input: '<div style="background-image:url(assets/img.png)">bg</div>',
    roundtrip: '<div style="background-image:url(assets/img.png)">bg</div>',
    cssom: '<div style="background-image: url(&quot;assets/img.png&quot;);">bg</div>',
  },
  {
    name: 'font-family-single-quotes',
    input: '<p style="font-family:\'Source Sans Pro\', Arial, sans-serif">type</p>',
    roundtrip: '<p style="font-family:\'Source Sans Pro\', Arial, sans-serif">type</p>',
    cssom: '<p style="font-family: &quot;Source Sans Pro&quot;, Arial, sans-serif;">type</p>',
  },
  {
    name: 'data-attrs-valueless',
    input:
      '<div data-x data-y="" data-note="a &lt; b" data-caption="He said &quot;hi&quot;">d</div>',
    roundtrip:
      '<div data-x="" data-y="" data-note="a &lt; b" data-caption="He said &quot;hi&quot;">d</div>',
    cssom:
      '<div data-x="" data-y="" data-note="a &lt; b" data-caption="He said &quot;hi&quot;">d</div>',
  },
  {
    name: 'class-whitespace',
    input: '<div class=" sl-block   content ">c</div>',
    roundtrip: '<div class=" sl-block   content ">c</div>',
    cssom: '<div class=" sl-block   content ">c</div>',
  },
  {
    name: 'pre-code-escaped-entities',
    input:
      '<pre><code class="language-html">&lt;div class=&quot;box&quot;&gt;\n  &lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;\n&lt;/div&gt;</code></pre>',
    roundtrip:
      '<pre><code class="language-html">&lt;div class="box"&gt;\n  &lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;\n&lt;/div&gt;</code></pre>',
    cssom:
      '<pre><code class="language-html">&lt;div class="box"&gt;\n  &lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;\n&lt;/div&gt;</code></pre>',
  },
  {
    name: 'sandpack-embed',
    input:
      '<div class="sl-block" data-block-type="sandpack"><div class="sl-block-content"><div class="sandpack-embed" data-template="react" data-theme="auto" data-layout="preview-right"><script type="application/json" data-sandpack-files>{"/App.js":{"code":"const x = 1 < 2 && \'y\';","active":true}}</script></div></div></div>',
    roundtrip:
      '<div class="sl-block" data-block-type="sandpack"><div class="sl-block-content"><div class="sandpack-embed" data-template="react" data-theme="auto" data-layout="preview-right"><script type="application/json" data-sandpack-files="">{"/App.js":{"code":"const x = 1 < 2 && \'y\';","active":true}}</script></div></div></div>',
    cssom:
      '<div class="sl-block" data-block-type="sandpack"><div class="sl-block-content"><div class="sandpack-embed" data-template="react" data-theme="auto" data-layout="preview-right"><script type="application/json" data-sandpack-files="">{"/App.js":{"code":"const x = 1 < 2 && \'y\';","active":true}}</script></div></div></div>',
  },
  {
    name: 'self-closing-and-entities-in-text',
    input: '<p>Hello&nbsp;world &amp; more<br/></p><img src="x.png" alt="" />',
    roundtrip: '<p>Hello&nbsp;world &amp; more<br></p><img src="x.png" alt="">',
    cssom: '<p>Hello&nbsp;world &amp; more<br></p><img src="x.png" alt="">',
  },
  {
    name: 'single-quoted-attrs',
    input: '<div data-caption=\'He said "hi" &amp; left\'>q</div>',
    roundtrip: '<div data-caption="He said &quot;hi&quot; &amp; left">q</div>',
    cssom: '<div data-caption="He said &quot;hi&quot; &amp; left">q</div>',
  },
  {
    name: 'section-with-style',
    input:
      '<section data-cm-id="sec00001" style="background-color:#123456" data-background-color="#ff5500"><h2>Sec</h2></section>',
    roundtrip:
      '<section data-cm-id="sec00001" style="background-color:#123456" data-background-color="#ff5500"><h2>Sec</h2></section>',
    cssom:
      '<section data-cm-id="sec00001" style="background-color: rgb(18, 52, 86);" data-background-color="#ff5500"><h2>Sec</h2></section>',
  },
];

/** Fixture lookup by name (throws on a typo instead of silently vacuous tests). */
export function browserFixture(name: string): BrowserSerializationFixture {
  const fixture = BROWSER_SERIALIZATION_FIXTURES.find(f => f.name === name);
  if (!fixture) throw new Error(`Unknown browser serialization fixture: ${name}`);
  return fixture;
}

/**
 * Pairs that look superficially similar but are GENUINELY different — the
 * equivalence must stay conservative and report every one of these as a real
 * difference (they would be real conflicts in a merge).
 */
export const TRUE_DIFFERENCE_CASES: Array<{ name: string; a: string; b: string }> = [
  {
    name: 'genuinely different color (not the hex↔rgb pair)',
    a: '<h2 style="color:#e07b39">Warm heading</h2>',
    b: '<h2 style="color: rgb(200, 123, 57);">Warm heading</h2>',
  },
  {
    name: 'genuinely different numeric value',
    a: '<div style="width: 600.5px">x</div>',
    b: '<div style="width: 600px">x</div>',
  },
  {
    name: 'text content change',
    a: '<p>Hello world</p>',
    b: '<p>Hello world!</p>',
  },
  {
    name: 'class token order change',
    a: '<div class="sl-block content">x</div>',
    b: '<div class="content sl-block">x</div>',
  },
  {
    name: 'code content change',
    a: '<pre><code>a &lt; b</code></pre>',
    b: '<pre><code>a &gt; b</code></pre>',
  },
  {
    name: 'code whitespace change',
    a: '<pre><code>if (x) {\n  y();\n}</code></pre>',
    b: '<pre><code>if (x) { y(); }</code></pre>',
  },
  {
    name: 'declaration removed',
    a: '<div style="color: red; top: 1px">x</div>',
    b: '<div style="color: red">x</div>',
  },
  {
    name: 'tag change',
    a: '<p>x</p>',
    b: '<div>x</div>',
  },
  {
    name: 'data attribute value change',
    a: '<div data-note="a">x</div>',
    b: '<div data-note="b">x</div>',
  },
  {
    name: 'sandpack payload change',
    a: '<div class="sandpack-embed"><script type="application/json" data-sandpack-files>{"/App.js":{"code":"const x = 1;"}}</script></div>',
    b: '<div class="sandpack-embed"><script type="application/json" data-sandpack-files>{"/App.js":{"code":"const x = 2;"}}</script></div>',
  },
];
