// Global type declarations for slides app

/** Minimal Reveal.js API surface used across the slides app */
interface RevealApi {
  initialize(): Promise<void>;
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
  getIndices(): { h: number; v: number; f?: number };
  getSlide(h: number, v: number): HTMLElement | null;
  getCurrentSlide(): HTMLElement;
  getSlidesElement(): HTMLElement | null;
  getScale(): number;
  configure(options: Record<string, unknown>): void;
}

/** Reveal.js constructor type (from dynamic import) */
interface RevealConstructor {
  new (container: HTMLElement, options: Record<string, unknown>): RevealApi;
}

/** Reveal.js plugin type */
interface RevealPlugin {
  id?: string;
  init?(deck: RevealApi): void | Promise<void>;
}

declare module 'reveal.js' {
  const Reveal: RevealConstructor;
  export default Reveal;
}

declare module 'reveal.js/plugin/highlight/highlight' {
  const RevealHighlight: RevealPlugin;
  export default RevealHighlight;
}

declare module 'reveal.js/plugin/notes/notes' {
  const RevealNotes: RevealPlugin;
  export default RevealNotes;
}

interface Window {
  Reveal?: RevealApi;
  __imageUploadResolve?: (url: string) => void;
  __imageUploadReject?: (error: Error) => void;
}
