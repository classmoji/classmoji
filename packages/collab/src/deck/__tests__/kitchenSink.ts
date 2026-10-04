/**
 * A deck that exercises every shape the converter has to carry: vertical
 * stack with container attrs + notes, hidden slide, fragments, speaker notes
 * (and an EMPTY notes aside), code, image, iframe with data-src, srcdoc
 * iframe, Sandpack with data-visible-files and a hidden /package.json,
 * background colour/image/iframe, slides.com-style absolute .sl-block layout,
 * attributes in non-alphabetical order, quotes and ampersands in attributes.
 */
import { SANDPACK_JSON } from '../../../../services/src/slides/__tests__/fixtures.ts';

const SANDPACK_FILES = JSON.stringify({
  '/App.js': { code: 'export default function App() {\n  return <h1>Hi &amp; bye</h1>;\n}' },
  '/package.json': { code: '{"dependencies":{"lodash":"4.17.21"}}', hidden: true },
});

export const KITCHEN_SINK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kitchen Sink</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" media="(prefers-color-scheme: light)">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/black.css" media="(prefers-color-scheme: dark)">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" media="not all and (prefers-color-scheme)">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" media="print">
  <style>.reveal h1 { color: #333; }</style>
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section data-cm-id="ks000001" data-transition="zoom" class="title-slide"><h1>Kitchen &amp; Sink</h1><p class="fragment">one</p><p class="fragment fade-up">two</p><aside class="notes">Opening notes with <b>markup</b></aside></section>
<section data-cm-id="ks000002" data-background-color="#112233"><h2>Code</h2><pre><code class="language-js">const a = 1 &lt; 2;
console.log(a);</code></pre></section>
<section data-cm-id="ks000003" data-hidden="true"><h2>Hidden slide</h2><aside class="notes"></aside></section>
<section data-cm-id="ks000004" data-background-image="https://example.com/bg.png?a=1&amp;b=2" data-background-size="cover"><img src="/content/org/repo/slides/ks/images/pic.png" alt="Pic"></section>
<section data-cm-id="ks000005" data-background-iframe="https://example.com/embed" data-background-interactive=""><h2>Iframe bg</h2></section>
<section data-cm-id="ks000006"><iframe data-src="https://example.com/lazy" width="800" height="400"></iframe></section>
<section data-cm-id="ks000007"><iframe srcdoc="&lt;p&gt;Hello &amp;amp; &quot;srcdoc&quot;&lt;/p&gt;" width="400"></iframe></section>
<section data-cm-id="ks000008"><div class="sl-block" data-block-type="sandpack" style="width: 900px; height: 500px; left: 30px; top: 100px;"><div class="sl-block-content"><div class="sandpack-embed" data-template="react" data-visible-files='["/App.js"]' data-show-line-numbers="false" data-theme="auto"><script type="application/json" data-sandpack-files>${SANDPACK_FILES}</script></div></div></div></section>
<section data-cm-id="ks000009"><div class="sl-block" data-block-type="sandpack"><div class="sl-block-content"><div class="sandpack-embed" data-template="react"><script type="application/json" data-sandpack-files>${SANDPACK_JSON}</script></div></div></div></section>
<section data-cm-id="ks000010" data-transition="fade" data-background-color="rgb(10, 20, 30)">
<section data-cm-id="ks000011" data-auto-animate=""><h2>Stack top</h2></section>
<section data-cm-id="ks000012"><h2>Stack middle</h2><aside class="notes">child note</aside></section>
<section data-cm-id="ks000013" data-hidden="true"><h2>Stack hidden child</h2></section>
<aside class="notes">stack-level note</aside>
</section>
<section data-cm-id="ks000014" style="color: red;" data-z="last" data-a="first"><div class="sl-block" data-block-type="text" style="width: 600px; left: 80px; top: 120px; height: auto;"><div class="sl-block-content" data-animation-type="fade-in"><h2>Absolute</h2></div></div><div class="sl-block" data-block-type="image" style="width: 300px; height: 200px; left: 500px; top: 300px;"><div class="sl-block-content"><img src="media://0b6c9b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b" alt=""></div></div></section>
<section data-cm-id="ks000015" data-caption='He said "hi" &amp; left'><h2>Quotes</h2><ul><li class="fragment">a</li><li class="fragment">b</li></ul></section>
<section data-cm-id="ks000016"><h2>Video</h2><video controls src="media://0b6c9b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5c"></video></section>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/highlight.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      controls: true,
      progress: true,
      center: false,
      transition: 'convex',
      width: 960,
      height: 700,
      plugins: [RevealHighlight]
    });
  </script>
</body>
</html>`;
