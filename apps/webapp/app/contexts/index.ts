import { createContext } from 'react';
import type { ToastPosition } from 'react-toastify';
import type { AppUser } from '~/types';

export const UserContext = createContext<{ user: AppUser | null }>({
  user: null,
});

export interface FetcherContextValue {
  fetcher: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- fetcher.data and submit shapes vary per route; no single generic satisfies all consumers
  notify: (action: string, message?: string, position?: ToastPosition) => void;
}

export const FetcherContext = createContext<FetcherContextValue>({
  fetcher: null,
  notify: () => {},
});
