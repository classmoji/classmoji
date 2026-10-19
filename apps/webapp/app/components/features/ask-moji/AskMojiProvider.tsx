import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { TriggerChatTransport } from '@trigger.dev/sdk/chat';
import { browserTimeZone } from '~/utils/browserTimeZone';
import { captureHandledError } from '~/utils/sentry.client';
import { createAskMojiApi } from './api';
import { AskMojiController, type AskMojiSessionTransport } from './controller';

/** The Trigger task every Ask Moji conversation runs (askMojiSession's ASK_MOJI_TASK_ID). */
export const ASK_MOJI_TASK_ID = 'ask-moji';

/** Exported for tests, which hand the panel a controller of their own. */
export const AskMojiContext = createContext<AskMojiController | null>(null);

/**
 * One controller (and one Trigger transport) per classroom and view, for as
 * long as this provider is mounted. Remount it (a `key`) to move to another
 * classroom or view. Client only: render it after hydration.
 *
 * The transport never gets `clientData` and no send passes request
 * `metadata`: both would reach the task's wire metadata, which it refuses.
 * Viewing rides on each message instead.
 */
export function AskMojiProvider({
  classroomSlug,
  viewAs,
  children,
}: {
  classroomSlug: string;
  viewAs: string | null;
  children: ReactNode;
}) {
  const [controller] = useState(() => {
    const api = createAskMojiApi(classroomSlug);
    const transport = new TriggerChatTransport({
      task: ASK_MOJI_TASK_ID,
      accessToken: async ({ chatId }) =>
        (await api.token({ conversationId: chatId })).publicAccessToken,
      startSession: async ({ chatId }) => api.ensureSession({ conversationId: chatId }),
    });
    return new AskMojiController({
      api,
      transport: transport as unknown as AskMojiSessionTransport,
      viewAs,
      browserTimeZone,
      onUnexpectedError: error => captureHandledError(error, 'ask-moji'),
    });
  });

  // Polling follows the tab's visibility; StrictMode's mount/unmount/mount
  // leaves the controller as it was.
  useEffect(() => {
    controller.mount();
    const onVisibility = () => controller.setVisible(document.visibilityState === 'visible');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      controller.unmount();
    };
  }, [controller]);

  return <AskMojiContext.Provider value={controller}>{children}</AskMojiContext.Provider>;
}

export function useAskMojiController(): AskMojiController {
  const controller = useContext(AskMojiContext);
  if (!controller) throw new Error('useAskMojiController outside AskMojiProvider');
  return controller;
}

export function useAskMojiSnapshot() {
  const controller = useAskMojiController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
