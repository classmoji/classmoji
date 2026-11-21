/**
 * Media held still for the pages a browser photographs (render-view for
 * deck_render, thumbnail-source for card images): every video and audio
 * element shows its first frame, paused, so two captures of the same slide are
 * the same picture.
 *
 * Why it is needed: reveal.js 6, when the browser refuses autoplay with sound,
 * retries the element muted, so a `data-autoplay` video (and a background
 * video) PLAYS during the capture and every screenshot catches a different
 * frame. reveal.js 5 left such a video paused on its first frame. Muted and
 * native-`autoplay` videos played under both, so their pictures were never
 * stable; they are held too.
 *
 * Only these two pages carry it. The stored `index.html`, opened on its own,
 * plays media the way reveal does.
 *
 * - A capture-phase `play` listener (media events do not bubble, capture still
 *   passes the document) pauses any element that starts and rewinds it to 0
 *   (and unmutes one Reveal muted for its retry). A video played for a moment
 *   and rewound draws the same first frame as one that never played.
 *   Previews in the app (previewMedia.ts) hold only the refused ones: muted
 *   videos keep playing there, which a picture cannot do.
 * - `stillMedia(roots, capMs)` pauses and rewinds the elements under `roots`,
 *   then waits until each is paused at 0, not seeking, and has its first frame
 *   (or has nothing to load), on two checks in a row so a `play()` Reveal
 *   issues from its own `loadeddata` handler is caught; bounded by `capMs`.
 *
 * Plain ES5 source, spliced inside each page script's own IIFE. Pure: no
 * imports, so a route module may reference it without pulling server code
 * into the client bundle.
 */
export const MEDIA_STILL_JS = `
  function cmHoldMedia(media) {
    if (!media.paused) media.pause();
    if (media.currentTime !== 0) media.currentTime = 0;
    // Muted by Reveal for its retry: as it was (previewMedia.ts does the same).
    if (media.hasAttribute('data-muted-by-reveal')) {
      media.muted = false;
      media.removeAttribute('data-muted-by-reveal');
    }
  }
  document.addEventListener('play', function (event) {
    var target = event.target;
    if (target && typeof target.pause === 'function') cmHoldMedia(target);
  }, true);
  function cmMediaStill(media) {
    if (!media.paused || media.seeking || media.currentTime !== 0) return false;
    if (!media.currentSrc || media.error || media.preload === 'none') return true;
    // A first frame to show, or the browser stopped loading (metadata only).
    return media.readyState >= 2 || media.networkState !== 2;
  }
  function stillMedia(roots, capMs) {
    return new Promise(function (resolve) {
      var until = Date.now() + capMs;
      var calm = 0;
      function check() {
        var media = [];
        roots.forEach(function (root) {
          if (!root) return;
          root.querySelectorAll('video, audio').forEach(function (el) { media.push(el); });
        });
        if (media.length === 0) return resolve();
        var still = true;
        media.forEach(function (el) {
          cmHoldMedia(el);
          if (!cmMediaStill(el)) still = false;
        });
        calm = still ? calm + 1 : 0;
        if (calm >= 2 || Date.now() >= until) return resolve();
        setTimeout(check, 50);
      }
      check();
    });
  }
`;
