import { createContext } from 'react';

export const UserContext = createContext({
  user: null,
});

export const FetcherContext = createContext({
  fetcher: null,
  notify: () => {},
});
