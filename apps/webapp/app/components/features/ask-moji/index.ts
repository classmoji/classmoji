export { default as AskMojiRoot, type AskMojiRootConfig } from './AskMojiRoot';
export { default as AskMojiPanel } from './AskMojiPanel';
export { default as AskMojiEmbed } from './AskMojiEmbed';
export { AskMojiProvider } from './AskMojiProvider';
export { useAskMojiAttempt, useAskMojiViewing, useHideAskMoji, viewingLabel } from './viewing';

/** The embed route's path (`/ask-moji/:class/embed`): the root renders the panel alone there. */
export const isAskMojiEmbedPath = (pathname: string) =>
  /^\/ask-moji\/[^/]+\/embed(?:\.data)?\/?$/.test(pathname);
