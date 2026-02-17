import { FetcherContext } from '~/contexts';
import { useContext } from 'react';

export const useGlobalFetcher = () => {
  const { fetcher, notify } = useContext(FetcherContext);
  return { fetcher, notify };
};
