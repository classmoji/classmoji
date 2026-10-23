/**
 * @vitest-environment jsdom
 *
 * Clean slide markup: the lists (safeMarkup/rules.ts) applied by both engines
 * — cheerio on the server, the DOM in the browser (jsdom here, parsing with
 * scripting on as a browser's `innerHTML` does) — which must agree node for
 * node, plus the editor's rename/restore round trip.
 */

import { describe, expect, it } from 'vitest';

import { HTML_BLOCK_SANDBOX, htmlBlockMarkup } from '../deckBlocks.ts';
import {
  INERT_NODE_ATTR,
  isSafeUrl,
  newSessionMarker,
  pageSessionMarker,
  restoreRenamed,
  restoreRenamedHtml,
  sanitizeClient,
  sanitizeClientToString,
  sanitizeNotesHtml,
  SESSION_MARKER_RE,
} from '../safeMarkup/index.ts';
import {
  sanitizeDeckDocumentServer,
  sanitizeServer,
  sanitizeServerResult,
} from '../safeMarkup/server.ts';

const doc = document;

const server = (html: string) => sanitizeServer(html);
const client = (html: string) => sanitizeClientToString(html, { mode: 'remove', doc });

/** Both engines, compared as the browser reads them (each output re-parsed and re-serialized). */
function both(html: string): string {
  const s = server(html);
  const c = client(html);
  const reparse = (out: string) => {
    const t = doc.createElement('template');
    t.innerHTML = out;
    return t.innerHTML;
  };
  expect(reparse(s)).toBe(reparse(c));
  return s;
}

/** Nothing that runs or navigates to script survives, read as a browser reads it. */
function assertInert(out: string): void {
  const t = doc.createElement('template');
  t.innerHTML = out;
  const banned = ['object', 'embed', 'base', 'meta', 'template', 'noscript', 'math', 'form'];
  for (const node of Array.from(t.content.querySelectorAll('*'))) {
    const tag = node.localName.toLowerCase();
    expect(banned, tag).not.toContain(tag);
    if (tag === 'script') {
      const type = (node.getAttribute('type') ?? '').trim().toLowerCase();
      expect(['application/json', 'text/template'], 'script type').toContain(type);
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      expect(name.startsWith('on'), `${tag} ${name}`).toBe(false);
      expect(['srcdoc', 'formaction', 'ping', 'data-notes', 'data-markdown']).not.toContain(name);
      if (name.startsWith('data-cm-inert-')) continue; // inert data, read by nothing
      // eslint-disable-next-line no-control-regex -- what a browser strips from a URL
      const v = attr.value.replace(/[\x00-\x20]/g, '').toLowerCase();
      expect(/^(javascript|vbscript|data:text\/html)/.test(v), `${tag} ${name}=${attr.value}`).toBe(
        false
      );
    }
  }
}

describe('sanitizer: hostile markup (both engines agree, output is inert)', () => {
  const cases: Array<[string, string]> = [
    ['event handler attributes', '<div onclick="alert(1)" ONMOUSEOVER="x()">hi</div>'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['javascript: href', '<a href="javascript:alert(1)">x</a>'],
    ['entity-encoded javascript: href', '<a href="&#106;avascript&colon;alert(1)">x</a>'],
    ['whitespace-padded scheme', '<a href="  \tjavascript:alert(1)">x</a>'],
    ['scheme with an embedded tab', '<a href="java&#9;script:alert(1)">x</a>'],
    ['upper-case scheme', '<a href="JaVaScRiPt:alert(1)">x</a>'],
    ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
    ['data:text/html iframe', '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>'],
    ['data:text/html link', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'],
    [
      'svg animate to a script href',
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text y="20">x</text></a></svg>',
    ],
    [
      'svg set to a script href',
      '<svg><a><set attributeName="xlink:href" to="javascript:alert(1)"/><text>x</text></a></svg>',
    ],
    [
      'svg script and handler',
      '<svg onload="alert(1)"><script>alert(1)</script><circle r="4"/></svg>',
    ],
    ['iframe srcdoc outside an html block', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['object', '<object data="x.swf"><param name="a" value="b"></object>'],
    ['embed', '<embed src="x.swf">'],
    ['base', '<base href="https://evil.example/">'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
    [
      'form action',
      '<form action="https://evil.example/"><input name="q"><button>go</button></form>',
    ],
    ['button formaction', '<button formaction="javascript:alert(1)">x</button>'],
    ['noscript style breakout', '<noscript><style></noscript><img src=x onerror=alert(1)></style>'],
    ['template', '<template><img src=x onerror=alert(1)></template>'],
    ['math mglyph', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'],
    ['svg p style breakout', '<svg></p><style><a title="</style><img src onerror=alert(1)>">'],
    ['select style', '<select><style></select><img src=x onerror=alert(1)></style>'],
    ['select template', '<select><template><img src=x onerror=alert(1)></template></select>'],
    [
      'data-notes with markup',
      '<section data-notes="<img src=x onerror=alert(1)>"><p>x</p></section>',
    ],
    ['data-preview-link breakout', `<a data-preview-link='x"><img src=x onerror=1>'>x</a>`],
    ['srcset with javascript:', '<img srcset="a.png 1x, javascript:alert(1) 2x">'],
    ['executable script', '<script>alert(1)</script>'],
    ['module script', '<script type="module">alert(1)</script>'],
    ['importmap script', '<script type="importmap">{"imports":{}}</script>'],
    ['link preload', '<link rel="preload" as="script" href="https://evil.example/x.js">'],
    ['link stylesheet over http', '<link rel="stylesheet" href="http://evil.example/x.css">'],
    ['xmp', '<xmp><img src=x onerror=alert(1)></xmp>'],
    ['frameset', '<frameset><frame src="javascript:alert(1)"></frameset>'],
    ['ping', '<a href="https://example.com" ping="https://evil.example/">x</a>'],
    [
      'data-background-iframe javascript:',
      '<section data-background-iframe="javascript:alert(1)"></section>',
    ],
    ['iframe javascript: src', '<iframe src="javascript:alert(1)"></iframe>'],
    ['video poster javascript:', '<video poster="javascript:alert(1)"></video>'],
    ['data-markdown', '<section data-markdown="https://evil.example/x.md"></section>'],
    ['comment trick', '<!--<img src=x onerror=alert(1)>--><p>x</p>'],
    [
      'svg foreignObject handler',
      '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>',
    ],
    ['svg use data html', '<svg><use href="data:text/html,<script>alert(1)</script>"/></svg>'],
    ['img name clobbering', '<img name="getElementById" src="a.png">'],
  ];

  for (const [label, html] of cases) {
    it(label, () => {
      const out = both(html);
      assertInert(out);
      expect(sanitizeServerResult(out).changes).toBe(0);
    });
  }

  it('drops the image src carrying the handler but keeps the image', () => {
    expect(both('<img src=x onerror=alert(1)>')).toBe('<img src="x">');
  });

  it('removes a form but keeps what was in it', () => {
    expect(both('<form action="/x"><p>keep</p></form>')).toBe('<p>keep</p>');
  });

  it('prefixes ids in the app’s reserved space', () => {
    expect(
      both('<div id="cm-reveal-config">x</div><div id="__cmView"></div><div id="intro"></div>')
    ).toBe(
      '<div id="user-cm-reveal-config">x</div><div id="user-__cmView"></div><div id="intro"></div>'
    );
  });
});

describe('sanitizer: deck markup that stays', () => {
  const kept: Array<[string, string]> = [
    [
      'Sandpack files script',
      '<div class="sandpack-embed" data-template="react"><script type="application/json" data-sandpack-files="">{"/App.js":{"code":"const x = 1 < 2;"}}</script></div>',
    ],
    [
      'text/template script',
      '<pre><code><script type="text/template">if (a < b) { x(); }</script></code></pre>',
    ],
    ['padded application/json type', '<script type=" application/json ">{"a":1}</script>'],
    ['style element', '<style>.reveal h1 { color: red; }</style>'],
    [
      'reveal data attributes',
      '<section data-background-color="#123" data-auto-animate="" data-transition="fade"><p class="fragment" data-fragment-index="2">x</p></section>',
    ],
    [
      'external link in a new tab',
      '<a target="_blank" href="https://example.com/x" rel="noopener">x</a>',
    ],
    [
      'relative and protocol-relative urls',
      '<img src="images/a.png"><img src="//cdn.example/b.png"><a href="#s2">x</a>',
    ],
    ['mailto', '<a href="mailto:a@example.com">mail</a>'],
    [
      'media reference',
      '<video controls="" src="media://0b6c9b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5c"></video>',
    ],
    ['about:blank', '<img src="about:blank">'],
    ['data image', '<img src="data:image/png;base64,iVBORw0KGgo=">'],
    [
      'data background image',
      '<section data-background-image="data:image/webp;base64,AAAA"></section>',
    ],
    ['stylesheet link', '<link rel="stylesheet" href="https://cdn.example/x.css">'],
    [
      'iframe embed',
      '<iframe src="https://www.youtube.com/embed/x" allow="autoplay; fullscreen" allowfullscreen="" width="560" height="315"></iframe>',
    ],
    ['lazy iframe', '<iframe data-src="games/snake/index.html"></iframe>'],
    [
      'svg with xlink and gradient',
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"></stop></linearGradient></defs><use xlink:href="#g"></use><rect fill="url(#g)" width="5" height="5"></rect></svg>',
    ],
    ['table', '<table><tbody><tr><td colspan="2">x</td></tr></tbody></table>'],
    ['speaker notes aside', '<aside class="notes"><p>say this</p></aside>'],
    ['srcset', '<img srcset="a.png 1x, b.png 2x" src="a.png">'],
  ];

  for (const [label, html] of kept) {
    it(label, () => {
      expect(both(html)).toBe(html);
      expect(sanitizeServerResult(html).changes).toBe(0);
    });
  }

  it('svg-block content stays as the svg-block lists keep it', () => {
    const block =
      '<div class="sl-block" data-block-type="svg"><div class="sl-block-content"><svg viewBox="0 0 10 10" width="100%" height="100%"><circle r="4" fill="currentColor"></circle><animate attributeName="r" values="1;4" dur="1s"></animate></svg></div></div>';
    expect(both(block)).toBe(block);
    const withForeign = block.replace('<circle', '<foreignObject><p>x</p></foreignObject><circle');
    expect(both(withForeign)).toBe(block);
  });

  it('an html block keeps its srcdoc frame under the safe sandbox', () => {
    const block = htmlBlockMarkup({
      id: 'b1',
      box: { left: 0, top: 0, width: 100, height: 100 },
      source: '<p>hi</p>',
    });
    expect(server(block)).toBe(block);
    expect(both(block)).toContain('srcdoc=');
  });

  it('an html block frame with an unsafe sandbox loses its sources', () => {
    const block = htmlBlockMarkup({
      id: 'b1',
      box: { left: 0, top: 0, width: 100, height: 100 },
      source: '<p>hi</p>',
    }).replace(`sandbox="${HTML_BLOCK_SANDBOX}"`, 'sandbox="allow-scripts allow-same-origin"');
    const out = both(block);
    expect(out).not.toContain('srcdoc');
    expect(out).toContain('allow-same-origin');
  });
});

describe('sanitizer: engines', () => {
  it('server output is stable under a second pass', () => {
    const tricky =
      '<svg></p><style><a title="</style><img src onerror=alert(1)>"><svg><style>&lt;/style&gt;&lt;img src=x onerror=1&gt;</style></svg>';
    const first = sanitizeServerResult(tricky);
    expect(first.changes).toBeGreaterThan(0);
    expect(sanitizeServerResult(first.html).changes).toBe(0);
  });

  it('clean markup comes back byte for byte', () => {
    const html = '<h2>Title</h2>\n<p class="x">a &amp; b</p>';
    expect(server(html)).toBe(html);
  });

  it('client engine returns a fragment owned by the template, with nothing loaded', () => {
    const frag = sanitizeClient('<p>x</p><img src=x onerror=alert(1)>', { mode: 'remove', doc });
    expect(frag.nodeType).toBe(11);
    const host = doc.createElement('div');
    host.replaceChildren(frag);
    expect(host.innerHTML).toBe('<p>x</p><img src="x">');
  });

  it('speaker notes after marked go through the same lists', () => {
    const frag = sanitizeNotesHtml(
      '<p>hi <img src=x onerror=alert(1)></p><script>x()</script>',
      doc
    );
    const host = doc.createElement('div');
    host.append(frag);
    expect(host.innerHTML).toBe('<p>hi <img src="x"></p>');
  });

  it('a whole deck document: only the slides are slide markup', () => {
    const page = [
      '<!DOCTYPE html>',
      '<html><head><meta charset="utf-8"><script src="https://cdn.example/reveal.js"></script></head>',
      '<body><div class="reveal"><div class="slides"><section><p onclick="x()">a</p><script>alert(1)</script></section></div></div>',
      '<script>\n    Reveal.initialize({});\n  </script></body></html>',
    ].join('\n');
    const out = sanitizeDeckDocumentServer(page);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('<script src="https://cdn.example/reveal.js"></script>');
    expect(out).toContain('<script>\n    Reveal.initialize({});\n  </script>');
    expect(out).toContain('<section><p>a</p></section>');
    expect(out).not.toContain('alert(1)');
  });
});

describe('isSafeUrl', () => {
  it.each([
    ['https://a.example/x', 'a', 'href', true],
    ['http://a.example/x', 'a', 'href', true],
    ['', 'img', 'src', true],
    ['x.png', 'img', 'src', true],
    ['data:image/png;base64,AA', 'img', 'src', true],
    ['data:image/svg+xml;base64,AA', 'img', 'src', false],
    ['data:image/png;base64,AA', 'a', 'href', false],
    ['data:image/png;base64,AA', 'iframe', 'src', false],
    ['blob:https://a.example/1', 'img', 'src', false],
    ['about:srcdoc', 'iframe', 'src', false],
    ['media://not-a-uuid', 'img', 'src', false],
    ['tel:123', 'a', 'href', false],
    ['x"y', 'a', 'href', false],
  ])('%s on %s[%s] → %s', (value, tag, attr, expected) => {
    expect(isSafeUrl(value, tag, attr)).toBe(expected);
  });
});

describe('rename mode (editor)', () => {
  const marker = newSessionMarker();
  const rename = (html: string, m = marker) =>
    sanitizeClientToString(html, { mode: 'rename', doc, marker: m });

  it('mints a fresh marker per call, one per page load', () => {
    expect(marker).toMatch(SESSION_MARKER_RE);
    expect(newSessionMarker()).not.toBe(marker);
    expect(pageSessionMarker()).toMatch(SESSION_MARKER_RE);
    expect(pageSessionMarker()).toBe(pageSessionMarker());
  });

  it('renames what may not render and restores it byte for byte', () => {
    const html =
      '<p onclick="go()" class="x">a</p><a href="javascript:void(0)" title="t">b</a><script>alert(1)</script><form action="/x" class="f"><input name="q"></form><img src="a.png" onerror="x()"><div id="cm-x">c</div>';
    const shown = rename(html);
    assertInert(shown.replace(/<template[^>]*>[\s\S]*?<\/template>/g, ''));
    expect(shown).toContain(`data-cm-inert-${marker}-onclick="go()"`);
    expect(shown).toContain(
      `<template ${INERT_NODE_ATTR}="${marker}"><script>alert(1)</script></template>`
    );
    expect(shown).toContain(
      `<div data-cm-inert-${marker}--tag="form" data-cm-inert-${marker}-action="/x" class="f">`
    );
    expect(restoreRenamedHtml(shown, marker, doc)).toBe(html);
  });

  it('restores in place on a live subtree', () => {
    const html =
      '<section><p onclick="go()">a</p><svg><script>x()</script><circle r="1"></circle></svg></section>';
    const host = doc.createElement('div');
    host.append(sanitizeClient(html, { mode: 'rename', doc, marker }));
    expect(host.innerHTML).not.toBe(html);
    restoreRenamed(host, marker);
    expect(host.innerHTML).toBe(html);
  });

  it('leaves another session’s inert names and templates as inert data', () => {
    const other = newSessionMarker();
    const planted = `<p data-cm-inert-${other}-onclick="go()">a</p><template ${INERT_NODE_ATTR}="${other}"><img src=x onerror=alert(1)></template>`;
    const shown = rename(planted);
    const restored = restoreRenamedHtml(shown, marker, doc);
    expect(restored).toContain(`data-cm-inert-${other}-onclick="go()"`);
    expect(restored).not.toContain(' onclick=');
    // restoring with the planted marker does not turn a template's content into live markup either
    expect(restored).toContain(`<template ${INERT_NODE_ATTR}="${other}">`);
  });

  it('html-block frame sources under an unsafe sandbox take the stored inert name', () => {
    const block = htmlBlockMarkup({
      id: 'b1',
      box: { left: 0, top: 0, width: 100, height: 100 },
      source: '<p>hi</p>',
    }).replace(`sandbox="${HTML_BLOCK_SANDBOX}"`, 'sandbox="allow-scripts allow-same-origin"');
    const shown = rename(block);
    expect(shown).toContain('data-cm-inert-srcdoc=');
    expect(restoreRenamedHtml(shown, marker, doc)).toContain('data-cm-inert-srcdoc=');
  });
});
