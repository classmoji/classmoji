/**
 * picomatch ships no types. Only the call the quiz's path exclusion makes
 * (agents/shared/exploration/excludedPaths.ts) is declared.
 */
declare module 'picomatch/posix' {
  interface PicomatchOptions {
    /** Match dotfiles and dot-directories with `*` and `**`. */
    dot?: boolean;
    nocase?: boolean;
  }
  function picomatch(
    glob: string | readonly string[],
    options?: PicomatchOptions
  ): (path: string) => boolean;
  export default picomatch;
}
