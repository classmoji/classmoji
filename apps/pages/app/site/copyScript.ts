/**
 * The class site's second (and last) inline script: the Copy buttons on code
 * and terminal blocks, and the copy guard for blocks whose author turned
 * copying off.
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
})();
`;
