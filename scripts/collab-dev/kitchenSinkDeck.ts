/**
 * The kitchen-sink deck's slides, as reveal.js `<section>` HTML. The seed
 * parses this with the services' own `parseDeckHtml` (the importer's parser),
 * so what lands in deck.json is exactly what an import of this HTML would
 * produce.
 *
 * Shape (Reveal hash → slide):
 *   #/0  title, fragments, speaker notes, zoom transition
 *   #/1  Editable slide A   (acceptance spec: user 1 locks it)
 *   #/2  Editable slide B   (acceptance spec: user 2 edits it)
 *   #/3  code + background colour
 *   #/4  python code + notes
 *   #/5  hidden slide
 *   #/6  image
 *   #/7  background image
 *   #/8  background iframe (interactive)
 *   #/9  iframe with data-src (lazy)
 *   #/10 srcdoc iframe
 *   #/11 Sandpack: data-visible-files + hidden /package.json with deps
 *   #/12 vertical stack (3 children, one hidden; stack-level notes)
 *   #/13 slides.com-style absolute .sl-block layout
 *   #/14 fragment list, quotes and ampersands in attributes
 *   #/15 video
 *   #/16 closing slide
 *
 * External media are public CC0 / placeholder URLs, so nothing here depends
 * on a media row or an asset that only exists in one database.
 */
import { DECK_SLIDE_A_TEXT, DECK_SLIDE_B_TEXT, KITCHEN_SINK_DECK_TITLE } from './constants.ts';

const VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

const SANDPACK_FILES = JSON.stringify({
  '/App.js': {
    code:
      "import { capitalize } from 'lodash';\n\n" +
      'export default function App() {\n' +
      "  return <h1>{capitalize('hello from sandpack')}</h1>;\n" +
      '}\n',
    active: true,
  },
  '/styles.css': { code: 'body { font-family: sans-serif; }\n' },
  '/package.json': {
    code: JSON.stringify({ dependencies: { lodash: '4.17.21' } }),
    hidden: true,
  },
});

const SECTIONS = [
  `<section data-transition="zoom"><h1>${KITCHEN_SINK_DECK_TITLE}</h1><p class="fragment">Fragment one</p><p class="fragment fade-up">Fragment two</p><aside class="notes">Opening notes with <b>markup</b>.</aside></section>`,
  `<section><h2>Editable slide A</h2><p>${DECK_SLIDE_A_TEXT}</p><aside class="notes">Notes for slide A.</aside></section>`,
  `<section><h2>Editable slide B</h2><p>${DECK_SLIDE_B_TEXT}</p></section>`,
  `<section data-background-color="#112233"><h2>Code</h2><pre><code class="language-js" data-line-numbers>const a = 1 &lt; 2;
console.log(a);</code></pre></section>`,
  `<section><h2>Python</h2><pre><code class="language-python">def greet(name):
    return f"Hello, {name}!"</code></pre><aside class="notes">Explain f-strings.</aside></section>`,
  `<section data-hidden="true"><h2>Hidden slide</h2><p>Only editors see this.</p></section>`,
  `<section><h2>Image</h2><img src="https://picsum.photos/id/1015/640/360" alt="A river valley" width="640" height="360"></section>`,
  `<section data-background-image="https://picsum.photos/id/1018/1600/900" data-background-size="cover"><h2 style="color: white;">Background image</h2></section>`,
  `<section data-background-iframe="https://example.com" data-background-interactive=""><h2>Background iframe</h2></section>`,
  `<section><h2>Lazy iframe</h2><iframe data-src="https://example.com" width="800" height="400"></iframe></section>`,
  `<section><h2>srcdoc iframe</h2><iframe srcdoc="&lt;p style=&quot;font-family: sans-serif&quot;&gt;Hello &amp;amp; welcome from srcdoc&lt;/p&gt;" width="600" height="200"></iframe></section>`,
  `<section><h2>Sandpack</h2><div class="sl-block" data-block-type="sandpack" style="width: 900px; height: 460px; left: 30px; top: 120px;"><div class="sl-block-content"><div class="sandpack-embed" data-template="react" data-visible-files='["/App.js","/styles.css"]' data-show-line-numbers="true" data-theme="auto"><script type="application/json" data-sandpack-files>${SANDPACK_FILES}</script></div></div></div></section>`,
  `<section data-background-color="rgb(10, 20, 30)">
<section data-auto-animate=""><h2>Stack top</h2></section>
<section><h2>Stack middle</h2><aside class="notes">Child slide note.</aside></section>
<section data-hidden="true"><h2>Stack hidden child</h2></section>
<aside class="notes">Stack-level note.</aside>
</section>`,
  `<section><div class="sl-block" data-block-type="text" style="width: 600px; left: 80px; top: 120px; height: auto;"><div class="sl-block-content" data-animation-type="fade-in"><h2>Absolute layout</h2><p>slides.com-style blocks</p></div></div><div class="sl-block" data-block-type="image" style="width: 300px; height: 200px; left: 560px; top: 320px;"><div class="sl-block-content"><img src="https://picsum.photos/id/1025/300/200" alt="A dog"></div></div></section>`,
  `<section data-caption='He said "hi" &amp; left'><h2>Fragments</h2><ul><li class="fragment">First</li><li class="fragment">Second</li><li class="fragment highlight-red">Third</li></ul></section>`,
  `<section><h2>Video</h2><video controls width="640" src="${VIDEO_URL}"></video></section>`,
  `<section><h2>Questions?</h2></section>`,
];

/** A minimal reveal document around the sections, for `parseDeckHtml`. */
export function kitchenSinkDeckHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${KITCHEN_SINK_DECK_TITLE}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/monokai.min.css">
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="monokai">
    <div class="slides">
${SECTIONS.join('\n')}
    </div>
  </div>
</body>
</html>`;
}
