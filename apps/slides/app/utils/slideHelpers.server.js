// Generate initial slide HTML template
export function generateSlideTemplate(title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/monokai.css">
  <style>
    .reveal h1, .reveal h2, .reveal h3 { color: #333; }
    .reveal .slides section { text-align: left; }
    .reveal pre { width: 100%; }
    .reveal code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="reveal">
    <div class="slides">
      <section>
        <h1>${title}</h1>
      </section>

      <section>
        <h2>Slide 2</h2>
        <p>Add your content here...</p>
      </section>

      <section>
        <h2>Code Example</h2>
        <pre><code class="language-javascript">// Your code here
function example() {
  return "Hello, World!";
}</code></pre>
      </section>

      <section>
        <h2>Questions?</h2>
      </section>
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
      transition: 'slide',
      plugins: [RevealHighlight]
    });
  </script>
</body>
</html>`;
}
