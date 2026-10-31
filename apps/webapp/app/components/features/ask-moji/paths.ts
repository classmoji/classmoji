/**
 * The embed route's path (`/ask-moji/:class/embed`): the root renders the
 * panel alone there. Its own module, so the root can ask without loading
 * anything else of Ask Moji.
 */
export const isAskMojiEmbedPath = (pathname: string) =>
  /^\/ask-moji\/[^/]+\/embed(?:\.data)?\/?$/.test(pathname);
