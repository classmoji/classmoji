/**
 * Frame readiness for the pages a browser photographs (render-view for
 * deck_render, thumbnail-source for card images): a slide is ready once the
 * frames on it have loaded — html blocks (srcdoc) and the `data-src` embeds
 * Reveal started on the shown slide — each wait bounded by the caller's cap,
 * so a frame that never loads only costs that cap.
 *
 * A sandboxed srcdoc frame exposes no document to its parent, so there is no
 * `complete` to read: a capture-phase `load` listener (frame `load` does not
 * bubble, capture still passes the document) records which srcdoc / src each
 * frame finished, and the window's own `load` — which every frame present
 * delays — marks all of them done. A frame is pending while its current
 * srcdoc / src is not the one recorded.
 *
 * Plain ES5 source, spliced inside each page script's own IIFE. Pure: no
 * imports, so a route module may reference it without pulling server code
 * into the client bundle.
 *
 * Defines `settleFrames(root, capMs) → Promise` (resolves when no frame under
 * `root` is pending, or at the cap).
 */
export const FRAME_SETTLE_JS = `
  var cmFrameDone = new WeakMap();
  var cmFrameWaiters = [];
  function cmFrameKey(frame) {
    if (frame.hasAttribute('srcdoc')) return 'srcdoc:' + frame.getAttribute('srcdoc');
    var src = frame.getAttribute('src');
    return src && src !== 'about:blank' ? 'src:' + src : '';
  }
  function cmFramePending(frame) {
    var key = cmFrameKey(frame);
    return key !== '' && cmFrameDone.get(frame) !== key;
  }
  function cmMarkAllFrames() {
    var all = document.querySelectorAll('iframe');
    for (var i = 0; i < all.length; i += 1) cmFrameDone.set(all[i], cmFrameKey(all[i]));
    cmFrameWaiters.slice().forEach(function (check) { check(); });
  }
  document.addEventListener('load', function (event) {
    var target = event.target;
    if (!target || target.tagName !== 'IFRAME') return;
    cmFrameDone.set(target, cmFrameKey(target));
    cmFrameWaiters.slice().forEach(function (check) { check(); });
  }, true);
  if (document.readyState === 'complete') cmMarkAllFrames();
  else window.addEventListener('load', cmMarkAllFrames);
  function settleFrames(root, capMs) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        var at = cmFrameWaiters.indexOf(check);
        if (at !== -1) cmFrameWaiters.splice(at, 1);
        resolve();
      }
      function check() {
        var frames = root.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i += 1) if (cmFramePending(frames[i])) return;
        finish();
      }
      cmFrameWaiters.push(check);
      setTimeout(finish, capMs);
      check();
    });
  }
`;
