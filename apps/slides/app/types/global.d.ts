// Global type declarations for slides app

declare module 'reveal.js' {
  const Reveal: any;
  export default Reveal;
}

declare module 'reveal.js/plugin/highlight/highlight' {
  const RevealHighlight: any;
  export default RevealHighlight;
}

declare module 'reveal.js/plugin/notes/notes' {
  const RevealNotes: any;
  export default RevealNotes;
}

interface Window {
  Reveal?: any;
}
