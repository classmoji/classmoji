// Global type declarations for slides app

/**
 * Minimal Reveal.js API surface used across the slides app. Instances are
 * created from reveal.js's own types and assigned to this, so it must stay a
 * subset of them (plus `isScrollView`, which reveal has but does not declare).
 */
interface RevealApi {
  initialize(): Promise<unknown>;
  destroy(): void;
  sync(): void;
  layout(): void;
  slide(h: number, v: number, f?: number): void;
  left(): void;
  right(): void;
  up(): void;
  down(): void;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Reveal.js event callbacks have varying signatures per event
  on(event: string, callback: Function): void;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Reveal.js event callbacks have varying signatures per event
  off(event: string, callback: Function): void;
  getIndices(slide?: HTMLElement): { h: number; v: number; f?: number };
  getSlide(h: number, v: number): HTMLElement | undefined;
  getCurrentSlide(): HTMLElement;
  getSlidesElement(): HTMLElement | null;
  getRevealElement?(): HTMLElement | null;
  /** The element reveal scrolls in its scroll view (<body> for a full-page deck). */
  getViewportElement?(): HTMLElement | null;
  /** True while reveal shows the deck as scrolling pages (phones). */
  isScrollView?(): boolean;
  getScale(): number;
  configure(options: Record<string, unknown>): void;
}

interface Window {
  Reveal?: RevealApi;
  __imageUploadResolve?: (url: string) => void;
  __imageUploadReject?: (error: Error) => void;
}
