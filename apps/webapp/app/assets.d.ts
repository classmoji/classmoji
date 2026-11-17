/// <reference types="vite/client" />

// A stylesheet-only package (its entry is index.css), imported for its side
// effect. vite/client's `*.css` pattern doesn't match a bare package name.
declare module '@fontsource-variable/mona-sans' {}

declare module 'emoji-js' {
  class EmojiConvertor {
    replace_mode: string;
    allow_native: boolean;
    replace_unified(): void;
    replace_colons(str: string): string;
  }
  export default EmojiConvertor;
}

declare module '*.png' {
  const content: string;
  export default content;
}
declare module '*.jpg' {
  const content: string;
  export default content;
}
declare module '*.jpeg' {
  const content: string;
  export default content;
}
declare module '*.svg' {
  const content: string;
  export default content;
}
declare module '*.gif' {
  const content: string;
  export default content;
}
declare module '*.webp' {
  const content: string;
  export default content;
}
declare module '*.mp3' {
  const content: string;
  export default content;
}
declare module '*.mp4' {
  const content: string;
  export default content;
}
declare module '*.wav' {
  const content: string;
  export default content;
}
