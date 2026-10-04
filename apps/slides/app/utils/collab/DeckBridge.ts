/**
 * The live deck editor's bridge between the Reveal editor's DOM and the deck
 * Y.Doc — slide-level, on top of the existing contenteditable editor.
 *
 * Every existing editing path (typing, the toolbar, the properties panel,
 * the overview's drag and drop, Sandpack's file sync) keeps mutating the DOM
 * exactly as it does in the git editor. The bridge watches the DOM
 * (MutationObserver + the editor's own onContentChange) and, debounced, works
 * out what the person changed against a per-slide BASELINE (what was last
 * rendered / written), then:
 *
 *  - structure (add, delete, move, stacks)   → straight into the doc, no lock;
 *    a delete of a slide someone else holds is refused and the slide put back;
 *  - attributes and visibility               → straight into the doc, per key;
 *  - a slide's html                          → only by the slide's lock holder:
 *    the first edit (or focus) claims the lock, the html is written once the
 *    claim is confirmed, and a slide someone else holds is read-only (an edit
 *    that slips in anyway, e.g. from the toolbar, is put back);
 *  - theme / code theme                      → straight into the doc.
 *
 * Remote changes are rendered back into the DOM: structure by moving section
 * elements (the slide with the caret never moves if it can stay), html only
 * for slides this person does not hold, attributes always (Reveal's runtime
 * paint is kept). Local edits are flushed into the doc before any remote
 * render, so a remote change never overwrites unsent work.
 *
 * Baselines compare like with like — DOM serialization with DOM
 * serialization, doc html with doc html — because browser `innerHTML` and the
 * server's cheerio output differ for the same markup.
 */
import * as Y from 'yjs';
import {
  LockActivity,
  acquireLock,
  allLocks,
  applyLocalStructure,
  deckMeta,
  deckSlideList,
  deckSlides,
  getLock,
  lockState,
  mintUniqueSlideId,
  planLocalStructure,
  planReorder,
  readDeckThemes,
  readSlideAttrs,
  readSlideHtml,
  releaseLock,
  renderSlideSection,
  sectionAttrString,
  setDeckThemes,
  structureOfEntries,
  structuresEqual,
  touchLock,
  writeAttrs,
  yDocToDeck,
  type DeckSlideEntry,
  type DeckStructure,
  type LockState,
  type NewSlideFields,
  type SlideLock,
} from '@classmoji/collab';

import { canonicalMediaUrls } from '../mediaRefs.ts';
import {
  applySectionAttrs,
  arrangeChildren,
  prepareEditorSection,
  scanDeckDom,
  sectionChildren,
  sectionFromMarkup,
  sectionOf,
  serializeSection,
} from './bridgeDom.ts';
import {
  SERIALIZE_DEBOUNCE_MS,
  decideLocalEdit,
  editingLabel,
  heartbeatDue,
  lockView,
  shouldRelease,
  shouldRenderRemoteHtml,
  type SlideLockView,
} from './bridgeLogic.ts';

/** Origin of every transaction the bridge writes (observers skip their own). */
export const BRIDGE_ORIGIN = 'deck-editor';

const MEDIA_REF_RE = /media:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface BridgeSession {
  readonly doc: Y.Doc;
  readonly user: { id: string; name: string; color: string };
  /** Every local update has reached the server. */
  readonly settled: boolean;
  connectedClients(): Set<number>;
  onUnsynced(listener: (pending: number) => void): () => void;
  setCurrentSlide(slideId: string | null): void;
}

export interface BridgeUiState {
  /** Locks by slide id (mine included). */
  locks: Record<string, SlideLockView>;
  heldSlideId: string | null;
  currentSlideId: string | null;
  /** Bumped whenever a remote change was rendered into the editor. */
  revision: number;
}

export interface DeckBridgeOptions {
  session: BridgeSession;
  mediaScope: { host: string | null | undefined; classroomId: string | null | undefined };
  /** Playable URLs for `media://` refs (missing ones stay as refs). */
  resolveMedia(refs: string[]): Promise<Map<string, string>>;
  notify(message: string): void;
  onState(state: BridgeUiState): void;
  clock?: () => number;
}

/** The part of RevealSlides' handle the bridge needs. */
export interface BridgeEditorHandle {
  setThemes(themes: { theme?: string; codeTheme?: string }): void;
}

interface Baseline {
  /** The doc html last rendered or written (undefined: container). */
  yHtml: string | undefined;
  /** The section's DOM serialization right after that. */
  domHtml: string | undefined;
  yAttrs: string;
  domAttrs: string;
  hidden: boolean;
}

interface Held {
  slideId: string;
  claimedAt: number;
  confirmed: boolean;
  lastEditAt: number;
  lastBeatAt: number;
  blurredAt: number | null;
}

const json = (value: unknown) => JSON.stringify(value);

export class DeckBridge {
  private readonly session: BridgeSession;
  private readonly doc: Y.Doc;
  private readonly opts: DeckBridgeOptions;
  private readonly clock: () => number;
  private readonly activity: LockActivity;

  private reveal: RevealApi | null = null;
  private handle: BridgeEditorHandle | null = null;
  private root: HTMLElement | null = null;
  private slidesEl: HTMLElement | null = null;
  private observer: MutationObserver | null = null;

  private baseline = new Map<string, Baseline>();
  private baselineStructure: DeckStructure | null = null;
  private dirtyAll = true;
  private dirtyStructure = false;
  private dirtyTheme = false;
  private dirtySlides = new Set<string>();
  /** Slides with an html edit waiting on our lock claim. */
  private pendingEdits = new Set<string>();
  private held: Held | null = null;
  private lastNotified = new Map<string, number>();

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastState = '';
  private revision = 0;
  private mediaUrls = new Map<string, string>();
  private mediaPending = new Set<string>();
  private readonly cleanups: Array<() => void> = [];
  private destroyed = false;
  private flushing = false;
  private flushAgain = false;

  constructor(opts: DeckBridgeOptions) {
    this.opts = opts;
    this.session = opts.session;
    this.doc = opts.session.doc;
    this.clock = opts.clock ?? Date.now;
    this.activity = new LockActivity(this.doc, this.clock);

    const onDocChange = (_events: unknown, tr: Y.Transaction) => {
      if (tr.origin === BRIDGE_ORIGIN) return;
      this.queueRender();
    };
    const slides = deckSlides(this.doc);
    const meta = deckMeta(this.doc);
    slides.observeDeep(onDocChange);
    meta.observe(onDocChange as never);
    this.cleanups.push(() => slides.unobserveDeep(onDocChange));
    this.cleanups.push(() => meta.unobserve(onDocChange as never));

    const locks = this.doc.getMap('locks');
    const onLocks = () => this.onLocksChanged();
    locks.observe(onLocks as never);
    this.cleanups.push(() => locks.unobserve(onLocks as never));

    this.cleanups.push(this.session.onUnsynced(() => this.checkClaim()));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Resolve the deck's media refs so the first render plays them. Bounded:
   * a slow lookup leaves the refs, and they are swapped in when they arrive.
   */
  async prepare(timeoutMs = 3000): Promise<void> {
    const refs = new Set<string>();
    for (const entry of deckSlideList(this.doc)) {
      for (const ref of (readSlideHtml(entry.map) ?? '').match(MEDIA_REF_RE) ?? []) {
        refs.add(ref.toLowerCase());
      }
    }
    if (refs.size === 0) return;
    await Promise.race([
      this.loadMedia([...refs]),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /**
   * The document the editor starts from: the live deck rendered as the
   * editor's input (no notes — they live in the notes panel), and the
   * baseline each slide is compared against.
   */
  initialDocument(): string {
    const deck = yDocToDeck(this.doc);
    this.baseline.clear();
    const sections = deck.slides
      .map(slide =>
        renderSlideSection(slide, {
          includeNotes: false,
          mapHtml: (html, s) => {
            this.baseline.set(s.id, {
              yHtml: html,
              domHtml: undefined,
              yAttrs: json(s.attrs ?? {}),
              domAttrs: '',
              hidden: Boolean(s.hidden),
            });
            return this.mapMedia(html);
          },
        })
      )
      .join('\n');
    for (const slide of deck.slides) {
      if (slide.children !== undefined) {
        this.baseline.set(slide.id, {
          yHtml: undefined,
          domHtml: undefined,
          yAttrs: json(slide.attrs ?? {}),
          domAttrs: '',
          hidden: Boolean(slide.hidden),
        });
      }
    }
    return this.documentShell(deck.theme, deck.codeTheme, sections);
  }

  /** The live deck as a static document (view mode after editing). */
  currentDocument(): string {
    const deck = yDocToDeck(this.doc);
    const sections = deck.slides
      .map(slide => renderSlideSection(slide, { mapHtml: html => this.mapMedia(html) }))
      .join('\n');
    return this.documentShell(deck.theme, deck.codeTheme, sections);
  }

  private documentShell(theme: string, codeTheme: string, sections: string): string {
    const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return (
      '<!DOCTYPE html><html><body>' +
      `<div class="reveal" data-theme="${attr(theme)}" data-code-theme="${attr(codeTheme)}">` +
      `<div class="slides">\n${sections}\n</div></div></body></html>`
    );
  }

  /** Bind to the editor once Reveal is ready in edit mode. */
  attach(reveal: RevealApi, handle: BridgeEditorHandle): void {
    this.detach();
    const slidesEl = reveal.getSlidesElement() as HTMLElement | null;
    const root = (reveal.getRevealElement?.() as HTMLElement | null) ?? slidesEl?.parentElement;
    if (!slidesEl || !root) return;
    this.reveal = reveal;
    this.handle = handle;
    this.slidesEl = slidesEl;
    this.root = root;

    // Baseline: the DOM as RevealSlides rendered initialDocument().
    const scan = scanDeckDom(slidesEl, taken => this.mintId(taken));
    for (const [id, el] of scan.elements) {
      const base = this.baseline.get(id);
      const ser = serializeSection(el);
      if (base) {
        base.domHtml = ser.html;
        base.domAttrs = json(ser.attrs);
      }
    }
    this.baselineStructure = scan.structure;
    this.dirtyAll = false;

    this.observer = new MutationObserver(records => this.onMutations(records));
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    const onFocus = () => this.onActivity('focus');
    const onBlur = () => {
      if (this.held) this.held.blurredAt = this.clock();
    };
    const onKey = () => this.onActivity('edit');
    root.addEventListener('focusin', onFocus);
    root.addEventListener('focusout', onBlur);
    root.addEventListener('keydown', onKey);
    root.addEventListener('input', onKey);
    const onSlideChanged = () => this.onSlideChanged();
    reveal.on('slidechanged', onSlideChanged);
    const onPageHide = () => this.releaseAll();
    window.addEventListener('pagehide', onPageHide);

    this.detachers = [
      () => root.removeEventListener('focusin', onFocus),
      () => root.removeEventListener('focusout', onBlur),
      () => root.removeEventListener('keydown', onKey),
      () => root.removeEventListener('input', onKey),
      () => reveal.off('slidechanged', onSlideChanged),
      () => window.removeEventListener('pagehide', onPageHide),
    ];

    this.ticker = setInterval(() => this.tick(), 1000);
    // Catch up with anything that changed while Reveal was initializing.
    this.render();
    this.onSlideChanged();
  }

  private detachers: Array<() => void> = [];

  /** Leave the editor (Done): flush, release, stop watching the DOM. */
  detach(): void {
    if (!this.slidesEl) return;
    this.flushLocal();
    this.releaseAll();
    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.detachers) fn();
    this.detachers = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.reveal = null;
    this.handle = null;
    this.slidesEl = null;
    this.root = null;
    this.session.setCurrentSlide(null);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.detach();
    this.destroyed = true;
    for (const fn of this.cleanups) fn();
    this.activity.destroy();
  }

  // ─── Inputs from the editor ──────────────────────────────────────────────

  /** The editor's onContentChange: something changed, sync soon. */
  notifyLocalChange = (): void => {
    if (!this.slidesEl) return;
    this.scheduleFlush();
  };

  /** Take over a slide whose holder is idle or gone. */
  takeOver(slideId: string): boolean {
    const result = acquireLock(
      this.doc,
      slideId,
      this.holder(),
      { ...this.lockContext(slideId), takeover: true },
      BRIDGE_ORIGIN
    );
    if (!result.ok) return false;
    this.releaseOthers(slideId);
    this.held = this.newHeld(slideId);
    this.applyLockChrome();
    this.emit();
    return true;
  }

  /** The notes text of a slide (character-level co-editing in the panel). */
  notesText(slideId: string | null): Y.Text | null {
    if (!slideId) return null;
    const map = deckSlides(this.doc).get(slideId);
    const notes = map instanceof Y.Map ? map.get('notes') : null;
    return notes instanceof Y.Text ? notes : null;
  }

  /** Empty notes are no notes (no empty aside on the slide). */
  clearNotesFlag(slideId: string): void {
    const map = deckSlides(this.doc).get(slideId);
    if (map instanceof Y.Map && map.has('hasNotes')) {
      this.doc.transact(() => map.delete('hasNotes'), BRIDGE_ORIGIN);
    }
  }

  currentSlideId(): string | null {
    const slide = this.reveal?.getCurrentSlide?.() as HTMLElement | undefined;
    return slide?.getAttribute('data-cm-id') ?? null;
  }

  // ─── DOM → doc ───────────────────────────────────────────────────────────

  private onMutations(records: MutationRecord[]): void {
    const slidesEl = this.slidesEl;
    const root = this.root;
    if (!slidesEl || !root) return;
    let touched = false;
    for (const record of records) {
      const target = record.target as Node;
      if (target === root) {
        if (
          record.type === 'attributes' &&
          (record.attributeName === 'data-theme' || record.attributeName === 'data-code-theme')
        ) {
          this.dirtyTheme = true;
          touched = true;
        }
        continue;
      }
      if (!slidesEl.contains(target)) continue;
      touched = true;
      if (record.type === 'childList') {
        const sectionsMoved = [...record.addedNodes, ...record.removedNodes].some(
          node => node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'section'
        );
        if (sectionsMoved || target === slidesEl) this.dirtyStructure = true;
      }
      const el = (target.nodeType === 1 ? target : target.parentElement) as Element | null;
      const section = el?.closest('section');
      const id = section?.getAttribute('data-cm-id');
      if (id) this.dirtySlides.add(id);
      else if (section) this.dirtyStructure = true;
    }
    if (touched) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushLocal();
    }, SERIALIZE_DEBOUNCE_MS);
  }

  /** Write the person's changes into the doc (see the module comment). */
  flushLocal(): void {
    if (this.flushing) {
      // Re-entered (a confirmed claim asks for a flush mid-flush): run again after.
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      this.flushOnce();
    } finally {
      this.flushing = false;
    }
    if (this.flushAgain) {
      this.flushAgain = false;
      this.flushLocal();
    }
  }

  private flushOnce(): void {
    const slidesEl = this.slidesEl;
    if (!slidesEl || this.destroyed) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.observer) this.onMutations(this.observer.takeRecords());

    const scan = scanDeckDom(slidesEl, taken => this.mintId(taken));
    const created = new Set<string>();
    let restore = false;

    const baseStructure = this.baselineStructure;
    if (
      baseStructure &&
      (this.dirtyStructure || scan.minted.length > 0) &&
      !structuresEqual(baseStructure, scan.structure)
    ) {
      const plan = planLocalStructure(baseStructure, scan.structure);
      for (const place of plan.places) if (place.create) created.add(place.id);
      const { refused } = applyLocalStructure(this.doc, plan, {
        origin: BRIDGE_ORIGIN,
        canDelete: id => !this.lockedByOther(id),
        newSlide: (id, container) => this.newSlideFields(scan.elements.get(id), container),
      });
      for (const id of created) {
        const el = scan.elements.get(id);
        if (el) this.rebaseFromDom(id, el);
      }
      if (refused.length > 0) {
        const holder = refused.map(id => this.otherHolder(id)).find(Boolean);
        this.opts.notify(
          `${holder ? editingLabel(holder.name) : 'Someone is editing'} that slide, so it stays.`
        );
        restore = true;
      }
      this.baselineStructure = scan.structure;
    }
    this.dirtyStructure = false;

    const dirty = this.dirtyAll
      ? [...scan.elements.keys()]
      : [...this.dirtySlides, ...this.pendingEdits];
    // The held slide first: its edit is written before a claim elsewhere releases it.
    const heldId = this.held?.slideId;
    const ids = heldId && dirty.includes(heldId) ? [heldId, ...dirty] : dirty;
    this.dirtyAll = false;
    this.dirtySlides.clear();
    const stillPending = new Set<string>();

    for (const id of new Set(ids)) {
      if (created.has(id)) continue;
      const el = scan.elements.get(id);
      const map = deckSlides(this.doc).get(id);
      if (!el || !(map instanceof Y.Map)) continue;
      const base = this.baseline.get(id);
      if (!base) {
        this.rebaseFromDom(id, el);
        continue;
      }
      const ser = serializeSection(el);

      if (ser.asideNotes != null) this.adoptAsideNotes(id, el, map, ser.asideNotes);

      const domAttrs = json(ser.attrs);
      if (domAttrs !== base.domAttrs || ser.hidden !== base.hidden) {
        this.doc.transact(() => {
          let attrs = map.get('attrs');
          if (!(attrs instanceof Y.Map)) {
            attrs = new Y.Map<unknown>();
            map.set('attrs', attrs);
          }
          if (domAttrs !== base.domAttrs) writeAttrs(map, attrs as Y.Map<unknown>, ser.attrs);
          if (map.get('hidden') !== ser.hidden) map.set('hidden', ser.hidden);
        }, BRIDGE_ORIGIN);
        base.domAttrs = domAttrs;
        base.yAttrs = domAttrs;
        base.hidden = ser.hidden;
      }

      if (ser.html === undefined || ser.html === base.domHtml) continue;
      switch (
        decideLocalEdit(this.lockStateOf(id), this.held?.slideId === id && this.held.confirmed)
      ) {
        case 'write': {
          const yHtml = canonicalMediaUrls(ser.html, this.opts.mediaScope);
          if (map.get('html') !== yHtml) {
            this.doc.transact(() => map.set('html', yHtml), BRIDGE_ORIGIN);
          }
          base.domHtml = ser.html;
          base.yHtml = yHtml;
          this.markEdit(id);
          break;
        }
        case 'claim':
          this.claim(id);
          stillPending.add(id);
          break;
        case 'wait':
          stillPending.add(id);
          break;
        case 'revert':
          this.revertSlide(id, el, map);
          break;
      }
    }
    this.pendingEdits = stillPending;

    if (this.dirtyTheme && this.root) {
      this.dirtyTheme = false;
      setDeckThemes(
        this.doc,
        {
          theme: this.root.getAttribute('data-theme') ?? undefined,
          codeTheme: this.root.getAttribute('data-code-theme') ?? undefined,
        },
        BRIDGE_ORIGIN
      );
    }

    if (restore) this.queueRender();
  }

  private newSlideFields(el: HTMLElement | undefined, container: boolean): NewSlideFields {
    if (!el) return container ? {} : { html: '' };
    const ser = serializeSection(el);
    const fields: NewSlideFields = { attrs: ser.attrs, hidden: ser.hidden };
    if (!container) fields.html = canonicalMediaUrls(ser.html ?? '', this.opts.mediaScope);
    if (ser.asideNotes) fields.notes = ser.asideNotes;
    return fields;
  }

  /** Notes typed (or pasted) into the slide itself move to the notes field. */
  private adoptAsideNotes(id: string, el: HTMLElement, map: Y.Map<unknown>, notes: string) {
    const text = map.get('notes');
    this.doc.transact(() => {
      if (text instanceof Y.Text && text.length === 0) text.insert(0, notes);
    }, BRIDGE_ORIGIN);
    this.mutateDom(() => {
      for (const aside of Array.from(el.querySelectorAll('aside.notes'))) {
        if (aside.closest('section') === el) aside.remove();
      }
    });
    void id;
  }

  private rebaseFromDom(id: string, el: HTMLElement): void {
    const map = deckSlides(this.doc).get(id);
    const ser = serializeSection(el);
    this.baseline.set(id, {
      yHtml: map instanceof Y.Map ? readSlideHtml(map) : ser.html,
      domHtml: ser.html,
      yAttrs: json(map instanceof Y.Map ? readSlideAttrs(map) : ser.attrs),
      domAttrs: json(ser.attrs),
      hidden: ser.hidden,
    });
  }

  private revertSlide(id: string, el: HTMLElement, map: Y.Map<unknown>): void {
    this.renderHtml(id, el, readSlideHtml(map));
    this.applyLockChrome();
    const holder = this.otherHolder(id);
    const now = this.clock();
    if (now - (this.lastNotified.get(id) ?? 0) > 5000) {
      this.lastNotified.set(id, now);
      this.opts.notify(`${holder ? editingLabel(holder.name) : 'Someone is editing'} this slide.`);
    }
  }

  // ─── doc → DOM ───────────────────────────────────────────────────────────

  private queueRender(): void {
    if (this.renderQueued || !this.slidesEl) {
      this.emit();
      return;
    }
    this.renderQueued = true;
    const run = () => {
      this.renderQueued = false;
      this.render();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /** Bring the DOM to the doc (see the module comment). */
  render(): void {
    const slidesEl = this.slidesEl;
    if (!slidesEl || this.destroyed) return;
    // Local first: absorb DOM changes not yet delivered, write them, then render.
    if (this.observer) this.onMutations(this.observer.takeRecords());
    if (this.flushTimer || this.dirtySlides.size > 0 || this.dirtyStructure || this.dirtyTheme) {
      this.flushLocal();
    }

    const entries = deckSlideList(this.doc);
    const target = structureOfEntries(entries);
    let structural = false;
    const currentId = this.currentSlideId();

    this.mutateDom(() => {
      const scan = scanDeckDom(slidesEl, taken => this.mintId(taken));
      const elements = scan.elements;
      const created = new Set<string>();
      if (!structuresEqual(scan.structure, target)) {
        structural = true;
        const byId = new Map(entries.map(e => [e.id, e]));
        for (const entry of entries) {
          if (elements.has(entry.id)) continue;
          elements.set(entry.id, this.createSection(entry));
          created.add(entry.id);
        }
        const pinned = this.caretSlideId();
        const rootOf = (id: string | null) => (id ? (byId.get(id)?.parent ?? id) : null);
        this.arrange(
          slidesEl,
          scan.structure.scopes.get(null) ?? [],
          target.scopes.get(null) ?? [],
          elements,
          rootOf(pinned)
        );
        for (const [scope, ids] of target.scopes) {
          if (scope === null) continue;
          const parentEl = elements.get(scope);
          if (!parentEl) continue;
          const current = sectionChildren(parentEl)
            .map(el => el.getAttribute('data-cm-id') ?? '')
            .filter(Boolean);
          this.arrange(parentEl, current, ids, elements, pinned);
        }
        for (const [id, el] of elements) {
          if (!byId.has(id)) {
            el.remove();
            this.baseline.delete(id);
          }
        }
      }

      for (const entry of entries) {
        const el = elements.get(entry.id);
        if (!el) continue;
        if (created.has(entry.id)) {
          this.rebaseFromDom(entry.id, el);
          continue;
        }
        const base = this.baseline.get(entry.id);
        if (!base) {
          this.rebaseFromDom(entry.id, el);
          continue;
        }
        const yHtml = readSlideHtml(entry.map);
        if (
          !entry.container &&
          shouldRenderRemoteHtml({
            yHtml,
            renderedYHtml: base.yHtml,
            heldByMe: this.held?.slideId === entry.id,
            claiming: this.pendingEdits.has(entry.id),
          })
        ) {
          this.renderHtml(entry.id, el, yHtml);
        }
        const yAttrs = readSlideAttrs(entry.map);
        const hidden = entry.map.get('hidden') === true;
        if (json(yAttrs) !== base.yAttrs || hidden !== base.hidden) {
          applySectionAttrs(el, yAttrs, hidden);
          this.revision++;
          base.yAttrs = json(yAttrs);
          base.domAttrs = json(serializeSection(el).attrs);
          base.hidden = hidden;
        }
      }
    });
    this.applyLockChrome();

    const themes = readDeckThemes(this.doc);
    if (
      this.root &&
      (this.root.getAttribute('data-theme') !== themes.theme ||
        this.root.getAttribute('data-code-theme') !== themes.codeTheme)
    ) {
      this.handle?.setThemes(themes);
    }

    this.baselineStructure = target;
    if (structural) this.revision++;
    if (structural && this.reveal) {
      this.reveal.sync();
      this.goTo(currentId);
      this.reveal.layout();
    }
    this.emit();
  }

  private arrange(
    parent: HTMLElement,
    current: string[],
    target: string[],
    elements: Map<string, HTMLElement>,
    pinned: string | null
  ): void {
    const { move } = planReorder(current, target, pinned);
    const ordered = target.map(id => elements.get(id)).filter(Boolean) as HTMLElement[];
    const moveEls = new Set([...move].map(id => elements.get(id)).filter(Boolean) as HTMLElement[]);
    arrangeChildren(parent, ordered, moveEls);
  }

  private createSection(entry: DeckSlideEntry): HTMLElement {
    const doc = (this.slidesEl as HTMLElement).ownerDocument;
    const slide = {
      id: entry.id,
      hidden: entry.map.get('hidden') === true,
      attrs: readSlideAttrs(entry.map),
      ...(entry.container ? {} : { html: readSlideHtml(entry.map) ?? '' }),
    };
    const markup = entry.container
      ? `<section${sectionAttrString(slide)}></section>`
      : renderSlideSection(slide, { includeNotes: false, mapHtml: html => this.mapMedia(html) });
    const el = sectionFromMarkup(doc, markup);
    prepareEditorSection(el, !this.lockedByOther(entry.id));
    return el;
  }

  private renderHtml(id: string, el: HTMLElement, yHtml: string | undefined): void {
    this.revision++;
    this.mutateDom(() => {
      el.innerHTML = this.mapMedia(yHtml ?? '');
      prepareEditorSection(el, !this.lockedByOther(id));
    });
    const base = this.baseline.get(id);
    const ser = serializeSection(el);
    if (base) {
      base.yHtml = yHtml;
      base.domHtml = ser.html;
    } else {
      this.rebaseFromDom(id, el);
    }
  }

  /** Run DOM writes without reading them back as local edits. */
  private mutateDom(fn: () => void): void {
    try {
      fn();
    } finally {
      this.observer?.takeRecords();
    }
  }

  private goTo(slideId: string | null): void {
    if (!slideId || !this.reveal || !this.slidesEl) return;
    const el = this.slidesEl.querySelector(`section[data-cm-id="${CSS.escape(slideId)}"]`);
    if (!el) return;
    const indices = this.reveal.getIndices(el as HTMLElement);
    const now = this.reveal.getIndices();
    if (indices.h !== now.h || indices.v !== now.v) this.reveal.slide(indices.h, indices.v ?? 0);
  }

  private caretSlideId(): string | null {
    if (!this.slidesEl) return null;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const node = selection?.anchorNode ?? null;
    const section = node ? sectionOf(node, this.slidesEl) : null;
    return section?.getAttribute('data-cm-id') ?? null;
  }

  // ─── Media ───────────────────────────────────────────────────────────────

  private mapMedia(html: string): string {
    const missing: string[] = [];
    const out = html.replace(MEDIA_REF_RE, ref => {
      const url = this.mediaUrls.get(ref.toLowerCase());
      if (!url) missing.push(ref.toLowerCase());
      return url ?? ref;
    });
    if (missing.length > 0) void this.loadMedia(missing).then(() => this.queueMediaRender());
    return out;
  }

  private async loadMedia(refs: string[]): Promise<void> {
    const todo = refs.filter(ref => !this.mediaUrls.has(ref) && !this.mediaPending.has(ref));
    if (todo.length === 0) return;
    for (const ref of todo) this.mediaPending.add(ref);
    try {
      const urls = await this.opts.resolveMedia(todo);
      for (const [ref, url] of urls) if (url && url !== ref) this.mediaUrls.set(ref, url);
    } catch {
      // Refs stay; a save stores refs anyway.
    }
  }

  private queueMediaRender(): void {
    // Re-render slides showing a ref that now has a URL (never one being edited).
    if (!this.slidesEl) return;
    const scan = scanDeckDom(this.slidesEl, taken => this.mintId(taken));
    for (const entry of deckSlideList(this.doc)) {
      const html = readSlideHtml(entry.map);
      if (!html || entry.container || this.held?.slideId === entry.id) continue;
      const el = scan.elements.get(entry.id);
      if (!el || !el.innerHTML.match(MEDIA_REF_RE)) continue;
      if (![...html.matchAll(MEDIA_REF_RE)].some(m => this.mediaUrls.has(m[0].toLowerCase()))) {
        continue;
      }
      this.renderHtml(entry.id, el, html);
    }
  }

  // ─── Locks ───────────────────────────────────────────────────────────────

  private holder() {
    return { ...this.session.user, userId: this.session.user.id, clientId: this.doc.clientID };
  }

  private lockContext(slideId: string) {
    return {
      now: this.clock(),
      connected: this.session.connectedClients(),
      idleMs: this.activity.idleMs(slideId),
    };
  }

  private lockStateOf(slideId: string): LockState {
    return lockState(getLock(this.doc, slideId), this.doc.clientID, this.lockContext(slideId));
  }

  private lockedByOther(slideId: string): boolean {
    const state = this.lockStateOf(slideId);
    return state === 'held' || state === 'stale';
  }

  private otherHolder(slideId: string): SlideLock | null {
    const lock = getLock(this.doc, slideId);
    return lock && lock.clientId !== this.doc.clientID ? lock : null;
  }

  private newHeld(slideId: string): Held {
    const now = this.clock();
    return {
      slideId,
      claimedAt: now,
      confirmed: false,
      lastEditAt: now,
      lastBeatAt: now,
      blurredAt: null,
    };
  }

  /** Claim a free slide (focus or first edit). One slide at a time. */
  private claim(slideId: string): void {
    if (this.held?.slideId === slideId) return;
    const result = acquireLock(
      this.doc,
      slideId,
      this.holder(),
      this.lockContext(slideId),
      BRIDGE_ORIGIN
    );
    if (!result.ok) return;
    this.releaseOthers(slideId);
    this.held = this.newHeld(slideId);
    this.applyLockChrome();
    this.checkClaim();
    this.emit();
  }

  private releaseOthers(keep: string): void {
    if (this.held && this.held.slideId !== keep) {
      releaseLock(this.doc, this.held.slideId, this.doc.clientID, BRIDGE_ORIGIN);
      this.held = null;
    }
    // Stray locks of ours (another tab of this page shares no clientID, so
    // these are from this doc only — e.g. a claim that lost and came back).
    for (const [slideId, lock] of allLocks(this.doc)) {
      if (slideId !== keep && lock.clientId === this.doc.clientID) {
        releaseLock(this.doc, slideId, this.doc.clientID, BRIDGE_ORIGIN);
      }
    }
  }

  /** Our claim is confirmed once the server has it and the lock still names us. */
  private checkClaim(): void {
    const held = this.held;
    if (!held || held.confirmed) return;
    const lock = getLock(this.doc, held.slideId);
    if (!lock || lock.clientId !== this.doc.clientID) return; // onLocksChanged handles the loss
    if (!this.session.settled) return;
    held.confirmed = true;
    if (this.pendingEdits.size > 0) this.flushLocal();
  }

  private onLocksChanged(): void {
    const held = this.held;
    if (held) {
      const lock = getLock(this.doc, held.slideId);
      if (!lock || lock.clientId !== this.doc.clientID) {
        // Lost: a simultaneous claim that won, or a takeover after we idled.
        this.held = null;
        const el = this.slidesEl?.querySelector(
          `section[data-cm-id="${CSS.escape(held.slideId)}"]`
        ) as HTMLElement | null;
        const map = deckSlides(this.doc).get(held.slideId);
        this.pendingEdits.delete(held.slideId);
        if (el && map instanceof Y.Map && lock) {
          this.revertSlide(held.slideId, el, map);
        }
      } else {
        this.checkClaim();
      }
    }
    this.applyLockChrome();
    this.emit();
  }

  /** Slides someone else holds are read-only; ours carry a quiet marker. */
  private applyLockChrome(): void {
    const slidesEl = this.slidesEl;
    if (!slidesEl) return;
    this.mutateDom(() => {
      for (const el of Array.from(slidesEl.querySelectorAll('section[data-cm-id]'))) {
        const section = el as HTMLElement;
        if (sectionChildren(section).length > 0) continue;
        const id = section.getAttribute('data-cm-id') as string;
        const other = this.lockedByOther(id);
        const mine = this.held?.slideId === id;
        const editable = other ? 'false' : 'true';
        if (section.getAttribute('contenteditable') !== editable) {
          section.setAttribute('contenteditable', editable);
        }
        section.classList.toggle('cm-locked', other);
        section.classList.toggle('cm-held', mine);
      }
    });
  }

  private onActivity(kind: 'focus' | 'edit'): void {
    if (!this.slidesEl) return;
    const id = this.caretSlideId();
    if (!id) return;
    if (this.held?.slideId === id) {
      this.held.blurredAt = null;
      if (kind === 'edit') this.markEdit(id);
      return;
    }
    if (this.lockStateOf(id) === 'free') {
      // Write the slide being left before its lock goes.
      if (this.held) this.flushLocal();
      this.claim(id);
    }
  }

  private markEdit(slideId: string): void {
    const held = this.held;
    if (!held || held.slideId !== slideId) return;
    const now = this.clock();
    held.lastEditAt = now;
    if (heartbeatDue(held.lastBeatAt, now)) {
      held.lastBeatAt = now;
      touchLock(this.doc, slideId, this.doc.clientID, now, BRIDGE_ORIGIN);
    }
  }

  private tick(): void {
    const held = this.held;
    if (held) {
      const focused = this.caretSlideId() === held.slideId && document.hasFocus();
      if (
        shouldRelease({
          now: this.clock(),
          lastEditAt: held.lastEditAt,
          focused,
          blurredAt: held.blurredAt,
        })
      ) {
        this.flushLocal();
        if (this.held === held) {
          releaseLock(this.doc, held.slideId, this.doc.clientID, BRIDGE_ORIGIN);
          this.held = null;
          this.applyLockChrome();
        }
      } else {
        this.checkClaim();
      }
    }
    if (this.pendingEdits.size > 0) this.flushLocal();
    this.emit();
  }

  private releaseAll(): void {
    if (this.held) {
      releaseLock(this.doc, this.held.slideId, this.doc.clientID, BRIDGE_ORIGIN);
      this.held = null;
    }
    this.releaseOthers('');
  }

  private mintId(taken: Set<string>): string {
    const slides = deckSlides(this.doc);
    return mintUniqueSlideId({ has: id => taken.has(id) || slides.has(id) });
  }

  // ─── UI state ────────────────────────────────────────────────────────────

  private onSlideChanged(): void {
    this.session.setCurrentSlide(this.currentSlideId());
    this.emit();
  }

  private emit(): void {
    if (this.destroyed) return;
    const locks: Record<string, SlideLockView> = {};
    for (const [slideId, lock] of allLocks(this.doc)) {
      const state = lockState(lock, this.doc.clientID, this.lockContext(slideId));
      locks[slideId] = lockView(slideId, lock, state);
    }
    const state: BridgeUiState = {
      locks,
      heldSlideId: this.held?.slideId ?? null,
      currentSlideId: this.currentSlideId(),
      revision: this.revision,
    };
    const key = json(state);
    if (key === this.lastState) return;
    this.lastState = key;
    this.opts.onState(state);
  }
}
