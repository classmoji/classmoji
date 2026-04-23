import { createContext } from 'react';
import type { FetcherWithComponents } from 'react-router';
import type { ToastPosition } from 'react-toastify';
import type { AppUser } from '~/types';

export const UserContext = createContext<{ user: AppUser | null }>({
  user: null,
});

export interface FetcherContextValue {
  fetcher: FetcherWithComponents<unknown> | null;
  notify: (action: string, message?: string, position?: ToastPosition) => void;
}

export const FetcherContext = createContext<FetcherContextValue>({
  fetcher: null,
  notify: () => {},
});
