import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { PagesUser } from '~/types/pages.ts';

interface StoreState {
  user: PagesUser | null;
  setUser: (user: PagesUser | null) => void;
}

/**
 * Zustand store for pages app state
 * Using Zustand instead of React Context prevents HMR issues
 * where context identity changes break the provider/consumer link
 */
const useStore = create<StoreState>()(
  devtools((set) => ({
    // User state
    user: null,
    setUser: (user: PagesUser | null) =>
      set((state: StoreState) => {
        if (state.user?.id === user?.id) return state;
        return { user };
      }),
  }))
);

export default useStore;
