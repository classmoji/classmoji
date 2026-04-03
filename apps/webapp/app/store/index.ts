import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  StoreState,
  AppUser,
  MembershipOrganization,
  MembershipWithOrganization,
  AppSubscription,
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
  setUser: (user: AppUser | null) =>
    set((state: StoreState) => {
      if (state.user?.id === user?.id) return state;
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

const useStore = create<StoreState>()(
  devtools(set => ({
    ...createUserSlice(set),
    ...createAppSlice(set),
  }))
);

export default useStore;
