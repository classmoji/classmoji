import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type {
  ActiveCallout,
  CalloutHandle,
  CalloutPayload,
} from './types.ts';
import { VARIANT_CONFIG } from './variants.ts';

const DEFAULT_SLOT_ID = 'default';
const BUFFER_TIMEOUT_MS = 500;
const PROGRESS_TO_SUCCESS_DISMISS_MS = 2000;

interface BufferedEntry {
  payload: ActiveCallout;
  timer: ReturnType<typeof setTimeout>;
}

export interface CalloutSlotInternal {
  active: ActiveCallout | null;
  registerSlot: () => void;
  unregisterSlot: () => void;
  dismiss: (id: string) => void;
}

export const CalloutHandleContext = createContext<CalloutHandle | null>(null);

interface SlotInternalContextValue {
  getActive: (slotId: string) => ActiveCallout | null;
  registerSlot: (slotId: string) => void;
  unregisterSlot: (slotId: string) => void;
  dismiss: (id: string) => void;
  /**
   * Monotonically increasing tick — slots subscribe to it (via context) so
   * they re-render when the registry changes. Stored on the context value
   * so the provider can bump it without changing the dispatcher identities.
   */
  tick: number;
}

const SlotInternalContext = createContext<SlotInternalContextValue | null>(
  null,
);

export interface CalloutProviderProps {
  children: ReactNode;
}

export function CalloutProvider({ children }: CalloutProviderProps) {
  // Single tick to trigger re-renders when registry changes.
  const [tick, setTick] = useState(0);
  const bumpTick = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  // Per-slot active payload.
  const slotsRef = useRef<Map<string, ActiveCallout | null>>(new Map());
  // Currently mounted slot ids.
  const mountedSlotsRef = useRef<Set<string>>(new Set());
  // Payloads waiting for their target slot to mount.
  const bufferedByTargetSlotRef = useRef<Map<string, BufferedEntry>>(new Map());
  // Auto-dismiss timers, keyed by callout id.
  const dismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const clearDismissTimer = useCallback((id: string) => {
    const timer = dismissTimersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      dismissTimersRef.current.delete(id);
    }
  }, []);

  const resolveAutoDismissMs = useCallback(
    (payload: CalloutPayload): number | null => {
      if (payload.persistent === true) return null;
      if (payload.autoDismissMs !== undefined) return payload.autoDismissMs;
      return VARIANT_CONFIG[payload.variant].defaultAutoDismissMs;
    },
    [],
  );

  // Forward-declare dismiss so scheduleAutoDismiss can call it.
  const dismissRef = useRef<(id: string) => void>(() => {});

  const scheduleAutoDismiss = useCallback(
    (payload: ActiveCallout) => {
      clearDismissTimer(payload.id);
      const ms = resolveAutoDismissMs(payload);
      if (ms === null || ms <= 0) return;
      const timer = setTimeout(() => {
        dismissRef.current(payload.id);
      }, ms);
      dismissTimersRef.current.set(payload.id, timer);
    },
    [clearDismissTimer, resolveAutoDismissMs],
  );

  const placeInSlot = useCallback(
    (slotId: string, active: ActiveCallout) => {
      slotsRef.current.set(slotId, active);
      scheduleAutoDismiss(active);
    },
    [scheduleAutoDismiss],
  );

  const clearBufferFor = useCallback((targetSlotId: string) => {
    const existing = bufferedByTargetSlotRef.current.get(targetSlotId);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
      bufferedByTargetSlotRef.current.delete(targetSlotId);
    }
  }, []);

  const findSlotForId = useCallback((id: string): string | null => {
    for (const [slotId, active] of slotsRef.current.entries()) {
      if (active && active.id === id) return slotId;
    }
    return null;
  }, []);

  const findBufferForId = useCallback((id: string): string | null => {
    for (const [
      targetSlotId,
      entry,
    ] of bufferedByTargetSlotRef.current.entries()) {
      if (entry.payload.id === id) return targetSlotId;
    }
    return null;
  }, []);

  // ---------- Public dispatchers (stable via refs) ----------

  const show = useCallback(
    (payload: CalloutPayload): string => {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `callout_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const targetSlotId = payload.slot ?? DEFAULT_SLOT_ID;
      const active: ActiveCallout = { ...payload, id, slot: targetSlotId };

      if (mountedSlotsRef.current.has(targetSlotId)) {
        clearBufferFor(targetSlotId);
        placeInSlot(targetSlotId, active);
        bumpTick();
        return id;
      }

      // Buffer until the slot mounts (or fall back to default).
      clearBufferFor(targetSlotId);
      const timer = setTimeout(() => {
        const entry = bufferedByTargetSlotRef.current.get(targetSlotId);
        if (entry === undefined) return;
        bufferedByTargetSlotRef.current.delete(targetSlotId);

        if (mountedSlotsRef.current.has(targetSlotId)) {
          placeInSlot(targetSlotId, entry.payload);
          bumpTick();
          return;
        }
        if (
          targetSlotId !== DEFAULT_SLOT_ID &&
          mountedSlotsRef.current.has(DEFAULT_SLOT_ID)
        ) {
          const fallback: ActiveCallout = {
            ...entry.payload,
            slot: DEFAULT_SLOT_ID,
          };
          placeInSlot(DEFAULT_SLOT_ID, fallback);
          bumpTick();
          return;
        }
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[Callout] Dropped callout id=${entry.payload.id}: no slot "${targetSlotId}" or "${DEFAULT_SLOT_ID}" mounted within ${BUFFER_TIMEOUT_MS}ms`,
          );
        }
      }, BUFFER_TIMEOUT_MS);

      bufferedByTargetSlotRef.current.set(targetSlotId, {
        payload: active,
        timer,
      });
      return id;
    },
    [bumpTick, clearBufferFor, placeInSlot],
  );

  const update = useCallback(
    (id: string, partial: Partial<CalloutPayload>): void => {
      // Live in a slot?
      const slotId = findSlotForId(id);
      if (slotId !== null) {
        const current = slotsRef.current.get(slotId);
        if (!current) return;
        const merged: ActiveCallout = { ...current, ...partial, id, slot: slotId };

        const isProgressToSuccessMorph =
          current.variant === 'progress' &&
          merged.variant === 'success' &&
          partial.autoDismissMs === undefined;

        slotsRef.current.set(slotId, merged);

        if (isProgressToSuccessMorph) {
          clearDismissTimer(id);
          const timer = setTimeout(() => {
            dismissRef.current(id);
          }, PROGRESS_TO_SUCCESS_DISMISS_MS);
          dismissTimersRef.current.set(id, timer);
        } else {
          scheduleAutoDismiss(merged);
        }
        bumpTick();
        return;
      }

      // Buffered?
      const bufferTarget = findBufferForId(id);
      if (bufferTarget !== null) {
        const entry = bufferedByTargetSlotRef.current.get(bufferTarget);
        if (entry === undefined) return;
        const merged: ActiveCallout = {
          ...entry.payload,
          ...partial,
          id,
          // Don't let `slot` in partial change the buffer target mid-flight.
          slot: entry.payload.slot,
        };
        entry.payload = merged;
      }
      // Otherwise: no-op (defensive — already dismissed).
    },
    [
      bumpTick,
      clearDismissTimer,
      findBufferForId,
      findSlotForId,
      scheduleAutoDismiss,
    ],
  );

  const dismiss = useCallback(
    (id: string): void => {
      let changed = false;
      const slotId = findSlotForId(id);
      if (slotId !== null) {
        slotsRef.current.set(slotId, null);
        clearDismissTimer(id);
        changed = true;
      }
      const bufferTarget = findBufferForId(id);
      if (bufferTarget !== null) {
        const entry = bufferedByTargetSlotRef.current.get(bufferTarget);
        if (entry !== undefined) {
          clearTimeout(entry.timer);
          bufferedByTargetSlotRef.current.delete(bufferTarget);
          changed = true;
        }
      }
      if (changed) bumpTick();
    },
    [bumpTick, clearDismissTimer, findBufferForId, findSlotForId],
  );

  // Keep dismissRef pointed at the latest dismiss closure.
  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);

  // ---------- Stable handle (refs so consumers don't re-render) ----------

  const showRef = useRef(show);
  const updateRef = useRef(update);
  const dismissPublicRef = useRef(dismiss);
  useEffect(() => {
    showRef.current = show;
  }, [show]);
  useEffect(() => {
    updateRef.current = update;
  }, [update]);
  useEffect(() => {
    dismissPublicRef.current = dismiss;
  }, [dismiss]);

  const handle = useMemo<CalloutHandle>(
    () => ({
      show: (payload) => showRef.current(payload),
      update: (id, partial) => updateRef.current(id, partial),
      dismiss: (id) => dismissPublicRef.current(id),
    }),
    [],
  );

  // ---------- Slot registration (for CalloutSlot) ----------

  const registerSlot = useCallback(
    (slotId: string) => {
      mountedSlotsRef.current.add(slotId);
      if (!slotsRef.current.has(slotId)) {
        slotsRef.current.set(slotId, null);
      }
      // If something is buffered for this slot, deliver immediately.
      const buffered = bufferedByTargetSlotRef.current.get(slotId);
      if (buffered !== undefined) {
        clearTimeout(buffered.timer);
        bufferedByTargetSlotRef.current.delete(slotId);
        placeInSlot(slotId, buffered.payload);
      }
      bumpTick();
    },
    [bumpTick, placeInSlot],
  );

  const unregisterSlot = useCallback(
    (slotId: string) => {
      mountedSlotsRef.current.delete(slotId);
      const active = slotsRef.current.get(slotId);
      if (active) {
        clearDismissTimer(active.id);
      }
      slotsRef.current.delete(slotId);
      bumpTick();
    },
    [bumpTick, clearDismissTimer],
  );

  const getActive = useCallback(
    (slotId: string): ActiveCallout | null =>
      slotsRef.current.get(slotId) ?? null,
    [],
  );

  const slotInternalValue = useMemo<SlotInternalContextValue>(
    () => ({
      getActive,
      registerSlot,
      unregisterSlot,
      dismiss,
      tick,
    }),
    [getActive, registerSlot, unregisterSlot, dismiss, tick],
  );

  // Clean up all timers on full provider unmount.
  useEffect(() => {
    const dismissTimers = dismissTimersRef.current;
    const bufferEntries = bufferedByTargetSlotRef.current;
    return () => {
      for (const timer of dismissTimers.values()) clearTimeout(timer);
      dismissTimers.clear();
      for (const entry of bufferEntries.values()) clearTimeout(entry.timer);
      bufferEntries.clear();
    };
  }, []);

  return (
    <CalloutHandleContext.Provider value={handle}>
      <SlotInternalContext.Provider value={slotInternalValue}>
        {children}
      </SlotInternalContext.Provider>
    </CalloutHandleContext.Provider>
  );
}

/**
 * Internal hook for `CalloutSlot` (Task 4) to register itself, read its
 * active payload, and dismiss callouts. Not for app code — app code uses
 * `useCallout()` from Task 5.
 */
export function useCalloutSlotInternal(slotId: string): CalloutSlotInternal {
  const ctx = useContext(SlotInternalContext);
  if (ctx === null) {
    throw new Error(
      'useCalloutSlotInternal must be used inside a <CalloutProvider>',
    );
  }
  // Subscribing to ctx (which carries `tick`) ensures the slot re-renders
  // whenever the registry changes.
  const active = ctx.getActive(slotId);
  const registerSlot = useCallback(() => {
    ctx.registerSlot(slotId);
  }, [ctx, slotId]);
  const unregisterSlot = useCallback(() => {
    ctx.unregisterSlot(slotId);
  }, [ctx, slotId]);
  return {
    active,
    registerSlot,
    unregisterSlot,
    dismiss: ctx.dismiss,
  };
}
