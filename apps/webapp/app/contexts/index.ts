import { createContext } from 'react';
import type { FetcherWithComponents } from 'react-router';
import type { AppUser } from '~/types';

export const UserContext = createContext<{ user: AppUser | null }>({
  user: null,
});

/**
 * A batch of Trigger.dev work an action kicked off. The runs are tagged
 * `session_<id>`, and `accessToken` is a read-only public token scoped to that
 * tag, so the browser can watch the batch and nothing else.
 */
export interface TriggerSession {
  id: string;
  accessToken: string;
}

/** A running operation; OperationProgress reports on it in its panel. */
export interface ActiveOperation {
  session: TriggerSession;
}

export interface FetcherContextValue {
  fetcher: FetcherWithComponents<unknown> | null;
  notify: (action: string, message?: string) => void;
  /** Set while a batch of background work is in flight; null otherwise. */
  operation: ActiveOperation | null;
  /** The operation has resolved: stop watching it. */
  endOperation: () => void;
  /** Drop the placeholder callout a caller opened before the work started. */
  dismissNotify: (action: string) => void;
}

export const FetcherContext = createContext<FetcherContextValue>({
  fetcher: null,
  notify: () => {},
  operation: null,
  endOperation: () => {},
  dismissNotify: () => {},
});
