import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { lockedSectionTitle } from '@classmoji/page-schema/sections';

import { useReaderSections } from '~/hooks/useReaderSections.tsx';
import { sectionStoreFor } from './sectionCheckbox.ts';
import {
  buildCracks,
  crackProgress,
  formatUnlockedAt,
  prefersReducedMotion,
  shatterGlass,
  type Crack,
} from './unlockEffects.ts';

/**
 * A locked section in the reader's view (the in-app viewer's render of the
 * shared `lockedSection` config).
 *
 * - staff reader: an open lock and the title; the body (children) renders
 *   below as usual.
 * - unlocked by this reader: a toggle (collapse/expand the body), the title,
 *   and when they opened it.
 * - locked: a card whose body is frosted glass over placeholder lines (the
 *   real body was never sent), with a hold-to-unlock control. The POST goes
 *   out only when the hold completes. Signed-in readers who may not unlock
 *   (not an accepted member, impersonated, classroom closed to them) get the
 *   card without the control.
 * - signed out (a public page): one compact row, the padlock and the title,
 *   that links to sign-in; hovering or focusing it says "Sign in to unlock".
 *   No card, no glass, no hold.
 *
 * "Unlocked" is shown only once the section is open in this editor: its body
 * is in, or it has none (the viewer publishes which, `filled` in the section
 * store). After a hold, the card stays broken open until the reloaded page's
 * body is in, or the reloaded page shows the section has no body.
 *
 * The title is the block's `title` prop (public).
 */

const HOLD_MS = 1200;
const DRAIN_MS = 300;
/** From completion to the shatter (padlock pops first). */
const SHATTER_DELAY_MS = 170;
/** Shortest time the card stays after completion, so the shards get going. */
const MIN_BREAK_MS = SHATTER_DELAY_MS + 280;
const MIN_BREAK_REDUCED_MS = 200;
/** After the shatter starts, placeholder lines shimmer if the body is not in yet. */
const SHIMMER_AFTER_MS = 700;

export interface LockedSectionViewProps {
  block: { id: string; props?: unknown; children: unknown[] };
  /** The viewer's editor (its section store says whether the section is open). */
  editor: object;
}

const NO_FILLED: ReadonlySet<string> = new Set();

type Mode = 'staff' | 'unlocked' | 'hold' | 'closed' | 'signin';

export function LockedSectionView({ block, editor }: LockedSectionViewProps) {
  const sections = useReaderSections();
  const id = block.id;
  const title = lockedSectionTitle(block) || 'Locked section';
  const store = sectionStoreFor(editor);
  const filled = useSyncExternalStore(
    store.subscribe,
    () => store.get().filled,
    () => NO_FILLED
  ).has(id);
  const unlockedAt = sections.unlocked[id];
  // The POST is out, or the page is being reloaded for the body.
  const pending = Boolean(sections.status[id]);

  // Local only: the hold completed here and the shards are still flying.
  const [breaking, setBreaking] = useState(false);
  const [breakDone, setBreakDone] = useState(false);
  // Bumped when an unlock fails, so the card comes back with its glass whole.
  const [attempt, setAttempt] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const hadFocus = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  let mode: Mode;
  if (!sections.known) mode = filled ? 'staff' : 'closed';
  else if (sections.staff) mode = 'staff';
  else if (unlockedAt && !pending && filled && (!breaking || breakDone)) mode = 'unlocked';
  else if (sections.canUnlock || pending || breaking) mode = 'hold';
  else if (!sections.signedIn) mode = 'signin';
  else mode = 'closed';

  // A failed unlock: the POST came back without recording anything, or the
  // reloaded page came back with the section still withheld. The card comes
  // back whole.
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending && !filled) {
      setBreaking(false);
      setBreakDone(false);
      setAttempt(a => a + 1);
    }
    wasPending.current = pending;
  }, [pending, filled]);

  const onComplete = useCallback(
    (focused: boolean) => {
      hadFocus.current = focused;
      setBreaking(true);
      setBreakDone(false);
      try {
        navigator.vibrate?.(15);
      } catch {
        // Not allowed here (iframe, permissions): the animation says it anyway.
      }
      sections.unlock(id);
      window.setTimeout(
        () => setBreakDone(true),
        prefersReducedMotion() ? MIN_BREAK_REDUCED_MS : MIN_BREAK_MS
      );
    },
    [sections, id]
  );

  // Opened in this visit: the body slides in once, focus follows, and the
  // live region says so.
  useLayoutEffect(() => {
    if (mode !== 'unlocked' || !sections.takeJustUnlocked(id)) return;
    setAnnouncement(`Unlocked: ${title}`);
    if (hadFocus.current) toggleRef.current?.focus({ preventScroll: true });
    const group = rootRef.current
      ?.closest('.bn-block')
      ?.querySelector<HTMLElement>(':scope > .bn-block-group');
    if (!group || typeof group.animate !== 'function') return;
    if (prefersReducedMotion()) {
      group.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      return;
    }
    const height = group.scrollHeight;
    group.animate(
      [
        { height: '0px', opacity: 0, overflow: 'hidden' },
        { height: `${height}px`, opacity: 1, overflow: 'hidden' },
      ],
      { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }, [mode, id, sections, title]);

  const metaText = mode === 'unlocked' ? formatUnlockedAt(unlockedAt) : '';
  const card = mode === 'hold' || mode === 'closed';

  if (mode === 'signin') {
    return <SignInToUnlock title={title} href={sections.signInUrl} />;
  }

  return (
    <div
      ref={rootRef}
      className={`pg-locked${card ? ' pg-locked-card' : ''}`}
      data-mode={mode}
      data-collapsed={mode === 'unlocked' && collapsed ? 'true' : 'false'}
    >
      <div className="pg-locked-row">
        {mode === 'unlocked' ? (
          <button
            ref={toggleRef}
            type="button"
            className="bn-toggle-button pg-locked-toggle"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} '${title}'`}
            onMouseDown={event => event.preventDefault()}
            onClick={() => setCollapsed(value => !value)}
          >
            <svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
              <path d="M320-200v-560l440 280-440 280Z" />
            </svg>
          </button>
        ) : null}
        {card ? <LockIcon /> : <LockOpenIcon />}
        <span className="pg-locked-title">{title}</span>
        {metaText ? (
          <span className="pg-locked-meta" contentEditable={false}>
            Unlocked {metaText}
          </span>
        ) : null}
      </div>
      {card ? (
        <HoldStage
          key={attempt}
          blockId={id}
          title={title}
          canUnlock={mode === 'hold'}
          waiting={pending}
          onComplete={onComplete}
        />
      ) : null}
      {mode === 'hold' ? (
        <p className="pg-locked-note" id={`pg-locked-note-${id}`} contentEditable={false}>
          Staff can see when you unlock this.
        </p>
      ) : null}
      <span className="pg-sr-only" aria-live="polite" contentEditable={false}>
        {announcement}
      </span>
    </div>
  );
}

/** Widths of the placeholder lines under the glass (no real text is ever here). */
const SKELETON = [92, 78, 86, 44, 70];

function HoldStage({
  blockId,
  title,
  canUnlock,
  waiting,
  onComplete,
}: {
  blockId: string;
  title: string;
  canUnlock: boolean;
  /** The POST is out (also true for a card rebuilt mid-unlock). */
  waiting: boolean;
  onComplete: (focused: boolean) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<SVGCircleElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const crackEls = useRef<Array<SVGPathElement | null>>([]);
  const [cracks, setCracks] = useState<{ list: Crack[]; w: number; h: number } | null>(null);
  // A card rebuilt while its unlock is in flight starts broken.
  const [broken, setBroken] = useState(waiting);
  const [shattered, setShattered] = useState(false);
  const [padOpen, setPadOpen] = useState(waiting);
  const [shimmer, setShimmer] = useState(waiting);

  const loop = useRef({ p: 0, holding: false, raf: 0, last: 0, done: waiting, dead: false });

  const apply = useCallback(() => {
    const s = loop.current;
    const p = s.p;
    if (ringRef.current) {
      ringRef.current.style.strokeDashoffset = String(1 - p);
      ringRef.current.style.strokeOpacity = p > 0.005 ? '1' : '0';
    }
    progressRef.current?.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    cracks?.list.forEach((crack, i) => {
      const offset = String(1 - crackProgress(p, crack.start));
      const hi = crackEls.current[i * 2];
      const lo = crackEls.current[i * 2 + 1];
      if (hi) hi.style.strokeDashoffset = offset;
      if (lo) lo.style.strokeDashoffset = offset;
    });
    const pane = paneRef.current;
    if (pane) {
      if (!prefersReducedMotion() && s.holding && p > 0.72) {
        const a = ((p - 0.72) / 0.28) * 2.4;
        pane.style.transform = `translate(${((Math.random() - 0.5) * 2 * a).toFixed(2)}px, ${((Math.random() - 0.5) * a).toFixed(2)}px)`;
      } else {
        pane.style.transform = '';
      }
    }
  }, [cracks]);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // Cracks fit the stage; rebuilt when it resizes and nothing is drawn yet.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const anchor = anchorRef.current;
    if (!stage || !anchor) return;
    const measure = () => {
      if (loop.current.p > 0) return;
      const sr = stage.getBoundingClientRect();
      const ar = anchor.getBoundingClientRect();
      if (!sr.width || !sr.height) return;
      const ox = ar.left + ar.width / 2 - sr.left;
      const oy = ar.top + ar.height / 2 - sr.top;
      setCracks(prev =>
        prev && Math.abs(prev.w - sr.width) < 1 && Math.abs(prev.h - sr.height) < 1
          ? prev
          : { list: buildCracks(blockId, sr.width, sr.height, ox, oy), w: sr.width, h: sr.height }
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [blockId]);

  useEffect(() => {
    apply();
  }, [apply]);

  useEffect(() => {
    const s = loop.current;
    s.dead = false;
    return () => {
      s.dead = true;
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
  }, []);

  const complete = useCallback(() => {
    const s = loop.current;
    if (s.done) return;
    s.done = true;
    s.holding = false;
    s.p = 1;
    applyRef.current();
    if (paneRef.current) paneRef.current.style.transform = '';
    buttonRef.current?.removeAttribute('data-holding');
    setPadOpen(true);
    const focused = Boolean(buttonRef.current && buttonRef.current === document.activeElement);
    onComplete(focused);
    const reduced = prefersReducedMotion();
    if (reduced) {
      // Reduced motion: the glass fades out, nothing flies.
      setBroken(true);
      window.setTimeout(() => !s.dead && setShimmer(true), 200);
      return;
    }
    window.setTimeout(() => {
      if (s.dead) return;
      const stage = stageRef.current;
      const anchor = anchorRef.current;
      if (stage && anchor) {
        const sr = stage.getBoundingClientRect();
        const ar = anchor.getBoundingClientRect();
        shatterGlass(
          stage,
          blockId,
          ar.left + ar.width / 2 - sr.left,
          ar.top + ar.height / 2 - sr.top
        );
      }
      setShattered(true);
      setBroken(true);
      window.setTimeout(() => !s.dead && setShimmer(true), SHIMMER_AFTER_MS);
    }, SHATTER_DELAY_MS);
  }, [blockId, onComplete]);

  const run = useCallback(() => {
    const s = loop.current;
    if (s.raf || s.dead) return;
    s.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(48, now - s.last);
      s.last = now;
      s.p = Math.max(0, Math.min(1, s.holding ? s.p + dt / HOLD_MS : s.p - dt / DRAIN_MS));
      applyRef.current();
      if (s.p >= 1 && s.holding) {
        s.raf = 0;
        complete();
        return;
      }
      s.raf = s.holding || s.p > 0 ? requestAnimationFrame(tick) : 0;
    };
    s.raf = requestAnimationFrame(tick);
  }, [complete]);

  const start = useCallback(() => {
    const s = loop.current;
    if (s.done || !canUnlock) return;
    s.holding = true;
    buttonRef.current?.setAttribute('data-holding', '');
    run();
  }, [canUnlock, run]);

  const release = useCallback(() => {
    const s = loop.current;
    if (s.done || !s.holding) return;
    s.holding = false;
    buttonRef.current?.removeAttribute('data-holding');
    run();
  }, [run]);

  // Switching windows mid-hold lets go.
  useEffect(() => {
    if (!canUnlock) return;
    window.addEventListener('blur', release);
    return () => window.removeEventListener('blur', release);
  }, [canUnlock, release]);

  const reducedFade = broken && !shattered;

  return (
    <div className="pg-locked-stage" ref={stageRef} contentEditable={false}>
      <div
        className={`pg-locked-skeleton${broken && shimmer && waiting ? ' pg-shimmer' : ''}`}
        aria-hidden="true"
      >
        {SKELETON.map(width => (
          <i key={width} style={{ width: `${width}%` }} />
        ))}
      </div>
      <div className="pg-locked-pane" ref={paneRef}>
        <div
          className={`pg-locked-glass pg-locked-fade${reducedFade ? ' pg-gone' : ''}`}
          style={shattered ? { visibility: 'hidden' } : undefined}
        />
        {cracks ? (
          <svg
            className={`pg-locked-cracks pg-locked-fade${reducedFade ? ' pg-gone' : ''}`}
            viewBox={`0 0 ${cracks.w} ${cracks.h}`}
            aria-hidden="true"
            style={shattered ? { visibility: 'hidden' } : undefined}
          >
            {cracks.list.map((crack, i) => [
              <path
                key={`h${i}`}
                ref={el => {
                  crackEls.current[i * 2] = el;
                }}
                className="pg-crack-hi"
                pathLength={1}
                d={crack.d}
              />,
              <path
                key={`l${i}`}
                ref={el => {
                  crackEls.current[i * 2 + 1] = el;
                }}
                className="pg-crack-lo"
                pathLength={1}
                d={crack.d}
              />,
            ])}
          </svg>
        ) : null}
        <div
          className={`pg-locked-ctrl pg-locked-fade${broken ? ' pg-gone' : ''}`}
          style={shattered ? { transform: 'scale(.85)' } : undefined}
        >
          {canUnlock ? (
            <>
              <div className="pg-hold" ref={anchorRef}>
                <div
                  ref={progressRef}
                  className="pg-hold-progress"
                  role="progressbar"
                  aria-label="Unlock progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={0}
                >
                  <svg className="pg-hold-ring" viewBox="0 0 64 64" aria-hidden="true">
                    <circle className="pg-ring-track" cx="32" cy="32" r="30" />
                    <circle
                      ref={ringRef}
                      className="pg-ring-fill"
                      cx="32"
                      cy="32"
                      r="30"
                      pathLength={1}
                    />
                  </svg>
                </div>
                <button
                  ref={buttonRef}
                  type="button"
                  className="pg-hold-btn"
                  aria-label={`Hold to unlock '${title}'`}
                  aria-describedby={`pg-locked-note-${blockId}`}
                  disabled={broken}
                  onPointerDown={event => {
                    if (event.button !== 0 || loop.current.done) return;
                    event.preventDefault();
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // Pointer already gone: the hold simply drains.
                    }
                    start();
                  }}
                  onPointerUp={release}
                  onPointerCancel={release}
                  onLostPointerCapture={release}
                  onContextMenu={event => event.preventDefault()}
                  onKeyDown={event => {
                    if (event.key !== ' ' && event.key !== 'Enter') return;
                    event.preventDefault();
                    if (!event.repeat) start();
                  }}
                  onKeyUp={event => {
                    if (event.key !== ' ' && event.key !== 'Enter') return;
                    event.preventDefault();
                    release();
                  }}
                  onBlur={release}
                >
                  <PadlockIcon open={padOpen} />
                </button>
              </div>
              <span className="pg-hold-label" aria-hidden="true">
                Hold to unlock
              </span>
            </>
          ) : (
            <div ref={anchorRef} className="pg-locked-anchor" />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A locked section for a signed-out reader: the padlock and the title, as a
 * link to sign in. The label shows on hover and on keyboard focus; the link's
 * accessible name says the same.
 */
function SignInToUnlock({ title, href }: { title: string; href: string | null }) {
  const label = `Sign in to unlock: ${title}`;
  const content = (
    <>
      <LockIcon />
      <span className="pg-locked-title">{title}</span>
      <span className="pg-locked-gate-tip" aria-hidden="true">
        Sign in to unlock
      </span>
    </>
  );
  return (
    <div className="pg-locked pg-locked-gate" data-mode="signin" contentEditable={false}>
      {href ? (
        <a className="pg-locked-row pg-locked-gate-link" href={href} aria-label={label}>
          {content}
        </a>
      ) : (
        // No sign-in URL from the loader (not expected for a signed-out
        // reader): the same row, not a link.
        <span className="pg-locked-row" title="Sign in to unlock">
          {content}
        </span>
      )}
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      className="pg-locked-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function LockOpenIcon() {
  return (
    <svg
      className="pg-locked-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

function PadlockIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`pg-pad${open ? ' pg-pad-open' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path className="pg-pad-shackle" d="M7 11V7a5 5 0 0 1 10 0v4" />
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <circle cx="12" cy="16.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
