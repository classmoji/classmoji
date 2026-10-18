import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  StoreState,
  AppUser,
  MembershipOrganization,
  MembershipWithOrganization,
  AppSubscription,
  TourPhase,
  AskMojiViewingState,
} from '~/types';
import type { Role } from '@prisma/client';

type SetState = (fn: ((state: StoreState) => Partial<StoreState>) | Partial<StoreState>) => void;

const createUserSlice = (set: SetState) => ({
  tokenBalance: null as number | null,
  role: null as Role | null,
  classroom: null as MembershipOrganization | null,
  user: null as AppUser | null,
  membership: null as MembershipWithOrganization | null,
  subscription: null as AppSubscription | null,
  setRole: (role: Role | null) =>
    set((state: StoreState) => {
      if (state.role === role) return state;
      return { role };
    }),
  setMembership: (membership: MembershipWithOrganization | null) =>
    set((state: StoreState) => {
      if (state.membership?.id === membership?.id) return state;
      return { membership };
    }),
  setClassroom: (classroom: MembershipOrganization | null) =>
    set((state: StoreState) => {
      const isSameId = state.classroom?.id === classroom?.id;
      // Compare timestamps instead of Date objects
      const isSameUpdatedAt =
        state.classroom?.updated_at?.getTime() === classroom?.updated_at?.getTime();
      // Also check settings updated_at since settings changes don't update classroom updated_at
      const isSameSettingsUpdatedAt =
        state.classroom?.settings?.updated_at?.getTime() ===
        classroom?.settings?.updated_at?.getTime();

      if (isSameId && isSameUpdatedAt && isSameSettingsUpdatedAt) {
        return state;
      }
      return { classroom };
    }),
  // Replace on any new object, not only on a new id: the row's fields change
  // too (email, school_id from account settings), and comparing ids alone
  // kept the old values on screen until a full reload.
  setUser: (user: AppUser | null) =>
    set((state: StoreState) => {
      if (state.user === user) return state;
      return { user };
    }),
  setSubscription: (subscription: AppSubscription | null) =>
    set((state: StoreState) => {
      if (state.subscription?.id === subscription?.id) return state;
      return { subscription };
    }),
  setTokenBalance: (tokenBalance: number | null) => set({ tokenBalance }),
});

const createAppSlice = (set: SetState) => ({
  showSpinner: false,
  setShowSpinner: (showSpinner: boolean) => set({ showSpinner }),
});

const createAskMojiSlice = (set: SetState) => ({
  isAskMojiOpen: false,
  setAskMojiOpen: (isAskMojiOpen: boolean) => set({ isAskMojiOpen }),
  askMojiEnabled: false,
  setAskMojiEnabled: (askMojiEnabled: boolean) =>
    set((state: StoreState) => {
      if (state.askMojiEnabled === askMojiEnabled) return state;
      return { askMojiEnabled };
    }),
  askMojiActive: false,
  setAskMojiActive: (askMojiActive: boolean) => set({ askMojiActive }),
  // What the user has open, as the route on screen publishes it
  // (useAskMojiViewing). A hint for the panel's "Viewing" chip and the next
  // message's metadata; the server resolves and checks it.
  askMojiViewing: null as AskMojiViewingState | null,
  setAskMojiViewing: (askMojiViewing: AskMojiViewingState | null) =>
    set((state: StoreState) => {
      if (sameViewing(state.askMojiViewing, askMojiViewing)) return state;
      return { askMojiViewing };
    }),
  // How many mounted routes ask for Ask Moji to be hidden (useHideAskMoji):
  // a live quiz attempt. Hidden while above zero.
  askMojiHideCount: 0,
  addAskMojiHide: () =>
    set((state: StoreState) => ({ askMojiHideCount: state.askMojiHideCount + 1 })),
  removeAskMojiHide: () =>
    set((state: StoreState) => ({ askMojiHideCount: Math.max(0, state.askMojiHideCount - 1) })),
});

const sameViewing = (a: AskMojiViewingState | null, b: AskMojiViewingState | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    a.id === b.id &&
    a.slide === b.slide &&
    a.title === b.title &&
    a.owner === b.owner);

// Guided tour orchestration. "Take a tour" calls startFullTour() -> phase
// 'landing'; OnboardingTour runs the landing steps and hands off to 'instructor'
// (the owner class tour), which hands off to 'student', which ends the sequence.
// Phase + step are persisted so a refresh resumes the tour in place. We use
// sessionStorage (not localStorage) on purpose: it survives a refresh but clears
// on tab close, so "resume" means resume-this-session, never a half-finished tour
// re-popping on the landing page days later.
const TOUR_STORAGE_KEY = 'cm-tour';

const persistTour = (tourPhase: TourPhase, tourStep: number) => {
  try {
    if (tourPhase === 'idle') sessionStorage.removeItem(TOUR_STORAGE_KEY);
    else
      sessionStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify({ phase: tourPhase, step: tourStep }));
  } catch {
    /* sessionStorage unavailable (SSR / private mode) */
  }
};

const createTourSlice = (set: SetState) => ({
  tourPhase: 'idle' as TourPhase,
  tourStep: 0,
  startFullTour: () =>
    set(() => {
      persistTour('landing', 0);
      return { tourPhase: 'landing', tourStep: 0 };
    }),
  setTourPhase: (tourPhase: TourPhase) =>
    set((state: StoreState) => {
      persistTour(tourPhase, state.tourStep);
      return { tourPhase };
    }),
  setTourStep: (tourStep: number) =>
    set((state: StoreState) => {
      persistTour(state.tourPhase, tourStep);
      return { tourStep };
    }),
  endTour: () =>
    set(() => {
      persistTour('idle', 0);
      return { tourPhase: 'idle', tourStep: 0 };
    }),
});

const useStore = create<StoreState>()(
  devtools(set => ({
    ...createUserSlice(set),
    ...createAppSlice(set),
    ...createAskMojiSlice(set),
    ...createTourSlice(set),
  }))
);

export default useStore;
