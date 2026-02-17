import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

const createUserSlice = set => ({
  tokenBalance: null,
  role: null,
  classroom: null,
  user: null,
  membership: null,
  subscription: null,
  setRole: role =>
    set(state => {
      if (state.role === role) return state;
      return { role };
    }),
  setMembership: membership =>
    set(state => {
      if (state.membership?.id === membership?.id) return state;
      return { membership };
    }),
  setClassroom: classroom =>
    set(state => {
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
  setUser: user =>
    set(state => {
      if (state.user?.id === user?.id) return state;
      return { user };
    }),
  setSubscription: subscription =>
    set(state => {
      if (state.subscription?.id === subscription?.id) return state;
      return { subscription };
    }),
  setTokenBalance: tokenBalance => set({ tokenBalance }),
});

const createAppSlice = set => ({
  showSpinner: false,
  setShowSpinner: showSpinner => set({ showSpinner }),
});

const useStore = create(
  devtools(set => ({
    ...createUserSlice(set),
    ...createAppSlice(set),
  }))
);

export default useStore;
