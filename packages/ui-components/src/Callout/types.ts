import type { ReactNode } from 'react';

export type CalloutVariant = 'success' | 'error' | 'info' | 'progress';

export interface CalloutAction {
  label: string;
  onClick: () => void;
}

export interface CalloutPayload {
  variant: CalloutVariant;
  title: string;
  message?: string;
  slot?: string;
  progress?: number;
  icon?: ReactNode;
  action?: CalloutAction;
  persistent?: boolean;
  autoDismissMs?: number | null;
}

export interface CalloutHandle {
  show: (payload: CalloutPayload) => string;
  update: (id: string, payload: Partial<CalloutPayload>) => void;
  dismiss: (id: string) => void;
}

export interface ActiveCallout extends CalloutPayload {
  id: string;
  slot: string;
}
