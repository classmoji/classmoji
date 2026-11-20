/**
 * Media in a preview deck (RevealPresenter's previewMode: the speaker view's
 * current and next panes, and thumbnails), where nobody can click.
 *
 * When the browser refuses a video's autoplay with sound, reveal.js 6 plays
 * it muted instead, marks it `data-muted-by-reveal`, and shows a button to
 * unmute it (js/controllers/slidecontent.js `playMediaElement`, 6.0.2
 * :469-504); reveal.js 5 left that video paused. In a preview the reveal.js 5
 * behaviour is kept: a video reveal.js muted is paused and unmuted as soon as
 * it starts, and global.css hides the button (`.reveal[data-preview]`).
 * Videos muted to begin with (and muted background videos) play as before.
 *
 * Install it on the deck element before Reveal initializes. Returns the
 * function that stops it. No imports, on purpose: the unit suite loads this
 * module as it is beside reveal.js in Chrome (tests/unit/preview-media.spec.ts).
 */
export function keepRefusedAutoplayPaused(deck: HTMLElement): () => void {
  // `play` does not bubble: listened for on the way down.
  const onPlay = (event: Event) => {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement) || !media.hasAttribute('data-muted-by-reveal')) return;
    media.pause();
    media.muted = false;
    media.removeAttribute('data-muted-by-reveal');
  };
  deck.addEventListener('play', onPlay, true);
  return () => deck.removeEventListener('play', onPlay, true);
}
