/**
 * The class site's second (and last) inline script: the Copy buttons on code
 * and terminal blocks, the copy guard for blocks whose author turned
 * copying off, and the bar that opens and closes a collapsible code block.
 *
 * A class site ships no bundle, so this is hand-written ES5 with no imports,
 * and its exact bytes are hashed into the site CSP (`SITE_COPY_SCRIPT_HASH`
 * in headers.server.ts, derived from this string, so the two cannot drift).
 *
 * The guard is `app/utils/copyGuard.ts`'s DOM algorithm (the read-only editor
 * view runs that one, plus a check of BlockNote's selection): a copy, cut or
 * drag whose selection reaches a `[data-copyable="false"]` block is rebuilt
 * from the selection with those blocks and the title-bar chrome removed; any
 * other copy is the browser's.
 * Change one, change the other — tests/unit/copy-guard.spec.ts runs both.
 *
 * The collapse bar is page-schema's codeCollapse.ts (`createCodeCollapse`),
 * minus what only an editor needs: the bar flips `data-collapse` on the
 * <pre> and its own `aria-expanded` (CSS clips, fades and picks the label),
 * animating the height unless the reader asked for reduced motion; a
 * collapsed <pre> the browser scrolls (find-in-page showing a hidden line)
 * opens, and the page scrolls by as much, so the match stays in view. Change
 * one, change the other — tests/unit/copy-guard.spec.ts runs this one too.
 */
export const SITE_COPY_SCRIPT = `
(function () {
  var BLOCKED = '[data-copyable="false"]';
  var CHROME = 'select, button, textarea, input, .bn-code-language, .terminal-header';
  var BLOCK_TAGS = ' ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DETAILS DIV DL DT FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TR UL ';
  function rangesOf(sel) {
    var out = [];
    for (var i = 0; i < sel.rangeCount; i++) out.push(sel.getRangeAt(i));
    return out;
  }
  function touches(sel) {
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    var blocked = document.querySelectorAll(BLOCKED);
    var ranges = rangesOf(sel);
    for (var i = 0; i < ranges.length; i++) {
      for (var j = 0; j < blocked.length; j++) {
        if (ranges[i].intersectsNode(blocked[j])) return true;
      }
    }
    return false;
  }
  function textOf(root) {
    var out = '';
    var pending = '';
    function push(text) {
      if (!text) return;
      if (pending && out) out += pending;
      pending = '';
      out += text;
    }
    function visit(node) {
      if (node.nodeType === 3) return push(node.nodeValue || '');
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      var tag = node.nodeType === 1 ? node.tagName : '';
      if (tag === 'BR') {
        out += '\\n';
        pending = '';
        return;
      }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return;
      var block = BLOCK_TAGS.indexOf(' ' + tag + ' ') > -1;
      if (block) pending = '\\n';
      for (var child = node.firstChild; child; child = child.nextSibling) visit(child);
      if (block) pending = '\\n';
      else if ((tag === 'TD' || tag === 'TH') && pending !== '\\n') pending = '\\t';
    }
    visit(root);
    return out;
  }
  function onCopy(event) {
    var target = event.target;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') && !target.closest(BLOCKED)) return;
    var sel = document.getSelection();
    if (!touches(sel)) return;
    var box = document.createElement('div');
    var ranges = rangesOf(sel);
    for (var i = 0; i < ranges.length; i++) {
      var common = ranges[i].commonAncestorContainer;
      var element = common.nodeType === 1 ? common : common.parentElement;
      if (element && element.closest(BLOCKED)) continue;
      var fragment = ranges[i].cloneContents();
      var drop = fragment.querySelectorAll(BLOCKED + ', ' + CHROME);
      for (var k = 0; k < drop.length; k++) drop[k].parentNode.removeChild(drop[k]);
      box.appendChild(fragment);
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.clipboardData) {
      event.clipboardData.setData('text/plain', textOf(box));
      event.clipboardData.setData('text/html', box.innerHTML);
    }
  }
  document.addEventListener('copy', onCopy, true);
  document.addEventListener('cut', onCopy, true);
  document.addEventListener('dragstart', function (event) {
    var sel = document.getSelection();
    if (!event.target || !touches(sel)) return;
    var ranges = rangesOf(sel);
    for (var i = 0; i < ranges.length; i++) {
      if (ranges[i].intersectsNode(event.target)) return event.preventDefault();
    }
  }, true);
  function fallbackCopy(value) {
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    area.parentNode.removeChild(area);
    return ok;
  }
  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('.bn-copy-button') : null;
    var block = button && button.closest('.bn-block-content');
    var pre = block && block.querySelector('pre');
    if (!pre) return;
    var value = pre.textContent || '';
    function done(ok) {
      if (!ok) return;
      button.setAttribute('data-copied', '');
      setTimeout(function () { button.removeAttribute('data-copied'); }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { done(true); }, function () { done(fallbackCopy(value)); });
    } else {
      done(fallbackCopy(value));
    }
  });
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function scrollerOf(element) {
    for (var node = element.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return document.scrollingElement || document.documentElement;
  }
  function animateFrom(pre, from) {
    var to = pre.getBoundingClientRect().height;
    if (Math.abs(to - from) < 2) return;
    var timer;
    function done() {
      clearTimeout(timer);
      pre.removeEventListener('transitionend', onEnd);
      pre.removeAttribute('data-animating');
      pre.style.maxHeight = '';
      if (!pre.getAttribute('style')) pre.removeAttribute('style');
    }
    function onEnd(event) {
      if (event.target === pre) done();
    }
    pre.style.maxHeight = from + 'px';
    void pre.offsetHeight;
    pre.setAttribute('data-animating', '');
    pre.style.maxHeight = to + 'px';
    pre.addEventListener('transitionend', onEnd);
    timer = setTimeout(done, 400);
  }
  function setOpen(pre, bar, open, animate) {
    var from = pre.getBoundingClientRect();
    var barTop = bar.getBoundingClientRect().top;
    pre.setAttribute('data-collapse', open ? 'expanded' : 'collapsed');
    bar.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && from.top < 0) {
      scrollerOf(pre).scrollTop += bar.getBoundingClientRect().top - barTop;
      return;
    }
    if (animate && !reducedMotion()) animateFrom(pre, from.height);
  }
  document.addEventListener('click', function (event) {
    var bar = event.target && event.target.closest ? event.target.closest('.bn-code-expand') : null;
    var block = bar && bar.closest('.bn-block-content');
    var pre = block && block.querySelector('pre[data-collapse]');
    if (!pre) return;
    setOpen(pre, bar, pre.getAttribute('data-collapse') === 'collapsed', true);
  });
  document.addEventListener('scroll', function (event) {
    var pre = event.target;
    if (!pre || pre.nodeType !== 1 || pre.getAttribute('data-collapse') !== 'collapsed' || pre.scrollTop <= 0) return;
    var block = pre.closest('.bn-block-content');
    var bar = block && block.querySelector('.bn-code-expand');
    if (!bar) return;
    var shift = pre.scrollTop;
    setOpen(pre, bar, true, false);
    pre.scrollTop = 0;
    scrollerOf(pre).scrollTop += shift;
  }, true);
})();
`;
