declare module '*.png' {
  const content: string;
  export default content;
}

declare module '*.svg' {
  const content: string;
  export default content;
}

// Stylesheets are imported for their side effect only.
declare module '*.css' {}
